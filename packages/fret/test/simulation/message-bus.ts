import { DeterministicRNG } from './deterministic-rng.js'
import { MetricsCollector } from './sim-metrics.js'

export interface SimMessage {
	from: string
	to: string
	type: 'neighbor-request' | 'neighbor-response' | 'route-request' | 'route-response' | 'leave-notice'
	payload: unknown
	scheduledDelivery: number
}

export interface LinkConfig {
	latencyMs: number | (() => number)
	lossRate: number
	queueCapacity: number
}

export type LatencyDistribution = 'constant' | 'uniform' | 'normal'

export interface MessageBusConfig {
	defaultLatencyMs: number
	defaultLossRate: number
	defaultQueueCapacity: number
	latencyDistribution: LatencyDistribution
	latencyJitter: number
}

interface LinkQueue {
	messages: SimMessage[]
	config: LinkConfig
}

export class SimMessageBus {
	private readonly rng: DeterministicRNG
	private readonly config: MessageBusConfig
	private readonly metrics: MetricsCollector
	private readonly linkOverrides = new Map<string, LinkConfig>()
	private readonly queues = new Map<string, LinkQueue>()
	private readonly pending: SimMessage[] = []

	private totalDropped = 0
	private totalSent = 0

	constructor(rng: DeterministicRNG, config: MessageBusConfig, metrics: MetricsCollector) {
		this.rng = rng
		this.config = config
		this.metrics = metrics
	}

	/** Set per-link overrides for heterogeneous topologies. */
	setLink(from: string, to: string, config: LinkConfig): void {
		this.linkOverrides.set(linkKey(from, to), config)
	}

	/** Get the effective link config for a given from→to pair. */
	private getLinkConfig(from: string, to: string): LinkConfig {
		const override = this.linkOverrides.get(linkKey(from, to))
		if (override) return override
		return {
			latencyMs: this.config.defaultLatencyMs,
			lossRate: this.config.defaultLossRate,
			queueCapacity: this.config.defaultQueueCapacity,
		}
	}

	/** Compute latency for a message based on distribution config. */
	private computeLatency(link: LinkConfig): number {
		const base = typeof link.latencyMs === 'function' ? link.latencyMs() : link.latencyMs
		switch (this.config.latencyDistribution) {
			case 'constant':
				return Math.max(0, base)
			case 'uniform': {
				const half = this.config.latencyJitter
				return Math.max(0, base + this.rng.nextInt(-half, half + 1))
			}
			case 'normal': {
				const jitter = this.rng.nextGaussian() * this.config.latencyJitter
				return Math.max(0, Math.round(base + jitter))
			}
		}
	}

	/**
	 * Send a message through the bus.
	 * Returns true if enqueued, false if dropped (loss or queue full).
	 */
	send(from: string, to: string, type: SimMessage['type'], payload: unknown, currentTime: number): boolean {
		this.totalSent++
		const link = this.getLinkConfig(from, to)

		// RNG-driven loss
		if (link.lossRate > 0 && this.rng.next() < link.lossRate) {
			this.totalDropped++
			this.metrics.recordMessageDrop()
			return false
		}

		// Check queue capacity
		const qKey = linkKey(from, to)
		let queue = this.queues.get(qKey)
		if (!queue) {
			queue = { messages: [], config: link }
			this.queues.set(qKey, queue)
		}
		if (queue.messages.length >= link.queueCapacity) {
			this.totalDropped++
			this.metrics.recordMessageDrop()
			return false
		}

		const latency = this.computeLatency(link)
		const msg: SimMessage = {
			from,
			to,
			type,
			payload,
			scheduledDelivery: currentTime + latency,
		}

		queue.messages.push(msg)
		this.pending.push(msg)
		return true
	}

	/**
	 * Deliver all messages whose scheduledDelivery <= upToTime.
	 * Returns messages in delivery-time order.
	 */
	deliver(upToTime: number): SimMessage[] {
		const ready: SimMessage[] = []
		const remaining: SimMessage[] = []

		for (const msg of this.pending) {
			if (msg.scheduledDelivery <= upToTime) {
				ready.push(msg)
			} else {
				remaining.push(msg)
			}
		}

		this.pending.length = 0
		this.pending.push(...remaining)

		// Remove delivered messages from their link queues
		for (const msg of ready) {
			const qKey = linkKey(msg.from, msg.to)
			const queue = this.queues.get(qKey)
			if (queue) {
				const idx = queue.messages.indexOf(msg)
				if (idx >= 0) queue.messages.splice(idx, 1)
			}
		}

		// Sort by delivery time for deterministic ordering
		ready.sort((a, b) => a.scheduledDelivery - b.scheduledDelivery)
		return ready
	}

	/** Number of messages currently in flight. */
	pendingCount(): number {
		return this.pending.length
	}

	/** Total messages dropped (loss + queue overflow). */
	droppedCount(): number {
		return this.totalDropped
	}

	/** Total messages sent (including dropped). */
	sentCount(): number {
		return this.totalSent
	}
}

function linkKey(from: string, to: string): string {
	return `${from}->${to}`
}

export interface CoverageSnapshot {
	time: number
	coverage: number
}

export interface SimMetrics {
	totalJoins: number
	totalLeaves: number
	totalConnections: number
	totalDisconnections: number
	stabilizationCycles: number
	neighborsFound: number
	avgNeighborCount: number
	avgPathLength: number
	convergenceTimeMs: number
	dropRate: number
	maxHopCount: number
	coverageTimeSeries: CoverageSnapshot[]
	routingAttempts: number
	routingSuccesses: number
	routingHops: number[]
	routingSuccessRate: number
	avgRoutingHops: number
	messageDrops: number
}

export interface PercentileSummary {
	p50: number
	p90: number
	p99: number
	max: number
}

export interface ConvergenceSummary {
	timeToTarget: number
	finalCoverage: number
}

export interface SimReport {
	meta: {
		seed: number
		config: Record<string, unknown>
		timestamp: string
		gitSha?: string
	}
	summary: SimMetrics
	distributions: {
		routingHops: PercentileSummary
		neighborCount: PercentileSummary
		convergence: ConvergenceSummary
	}
}

/** Compute a percentile value from a sorted array using nearest-rank. */
export function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0
	const idx = Math.ceil((p / 100) * sorted.length) - 1
	return sorted[Math.max(0, idx)]!
}

/** Build a PercentileSummary from an unsorted array. */
export function percentileSummary(values: number[]): PercentileSummary {
	if (values.length === 0) return { p50: 0, p90: 0, p99: 0, max: 0 }
	const sorted = [...values].sort((a, b) => a - b)
	return {
		p50: percentile(sorted, 50),
		p90: percentile(sorted, 90),
		p99: percentile(sorted, 99),
		max: sorted[sorted.length - 1]!,
	}
}

export interface SimReportConfig {
	seed: number
	config: Record<string, unknown>
}

export class MetricsCollector {
	private metrics: SimMetrics = {
		totalJoins: 0,
		totalLeaves: 0,
		totalConnections: 0,
		totalDisconnections: 0,
		stabilizationCycles: 0,
		neighborsFound: 0,
		avgNeighborCount: 0,
		avgPathLength: 0,
		convergenceTimeMs: 0,
		dropRate: 0,
		maxHopCount: 0,
		coverageTimeSeries: [],
		routingAttempts: 0,
		routingSuccesses: 0,
		routingHops: [],
		routingSuccessRate: 0,
		avgRoutingHops: 0,
		messageDrops: 0,
	}

	private neighborCounts: number[] = []
	private pathLengths: number[] = []

	recordJoin(): void {
		this.metrics.totalJoins++
	}

	recordLeave(): void {
		this.metrics.totalLeaves++
	}

	recordConnection(): void {
		this.metrics.totalConnections++
	}

	recordDisconnection(): void {
		this.metrics.totalDisconnections++
	}

	recordStabilization(): void {
		this.metrics.stabilizationCycles++
	}

	recordNeighbors(count: number): void {
		this.metrics.neighborsFound += count
		this.neighborCounts.push(count)
	}

	recordPath(hopCount: number): void {
		this.pathLengths.push(hopCount)
		if (hopCount > this.metrics.maxHopCount) this.metrics.maxHopCount = hopCount
	}

	recordConvergence(timeMs: number): void {
		this.metrics.convergenceTimeMs = timeMs
	}

	recordCoverage(time: number, coverage: number): void {
		this.metrics.coverageTimeSeries.push({ time, coverage })
	}

	recordMessageDrop(): void {
		this.metrics.messageDrops++
	}

	recordRoute(success: boolean, hops: number): void {
		this.metrics.routingAttempts++
		if (success) this.metrics.routingSuccesses++
		this.metrics.routingHops.push(hops)
	}

	finalize(): SimMetrics {
		if (this.neighborCounts.length > 0) {
			this.metrics.avgNeighborCount =
				this.neighborCounts.reduce((a, b) => a + b, 0) / this.neighborCounts.length
		}
		if (this.pathLengths.length > 0) {
			this.metrics.avgPathLength =
				this.pathLengths.reduce((a, b) => a + b, 0) / this.pathLengths.length
		}
		const totalAttempts = this.metrics.totalConnections + this.metrics.totalDisconnections
		if (totalAttempts > 0) {
			this.metrics.dropRate = this.metrics.totalDisconnections / totalAttempts
		}
		if (this.metrics.routingAttempts > 0) {
			this.metrics.routingSuccessRate = this.metrics.routingSuccesses / this.metrics.routingAttempts
		}
		if (this.metrics.routingHops.length > 0) {
			this.metrics.avgRoutingHops =
				this.metrics.routingHops.reduce((a, b) => a + b, 0) / this.metrics.routingHops.length
		}
		return { ...this.metrics, coverageTimeSeries: [...this.metrics.coverageTimeSeries] }
	}

	getMetrics(): Readonly<SimMetrics> {
		return this.metrics
	}

	/** Build a full SimReport with distribution summaries. */
	toReport(reportConfig: SimReportConfig): SimReport {
		const summary = this.finalize()
		const series = summary.coverageTimeSeries
		const finalCoverage = series.length > 0 ? series[series.length - 1]!.coverage : 0
		const targetThreshold = 0.8
		const timeToTarget = series.find((s) => s.coverage >= targetThreshold)?.time ?? -1

		return {
			meta: {
				seed: reportConfig.seed,
				config: reportConfig.config,
				timestamp: new Date().toISOString(),
				gitSha: typeof process !== 'undefined' ? process.env.GIT_SHA : undefined,
			},
			summary,
			distributions: {
				routingHops: percentileSummary(summary.routingHops),
				neighborCount: percentileSummary(this.neighborCounts),
				convergence: { timeToTarget, finalCoverage },
			},
		}
	}

	/** Serialize to CI-consumable JSON. */
	toJSON(reportConfig: SimReportConfig): string {
		return JSON.stringify(this.toReport(reportConfig), null, 2)
	}
}

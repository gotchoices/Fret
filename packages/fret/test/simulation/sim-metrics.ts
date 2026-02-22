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
}

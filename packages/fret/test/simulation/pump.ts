import type { FretSimulation } from './fret-sim.js'

/** Drive every event scheduled up to `uptoMs`, then park the clock there. */
export function pump(sim: FretSimulation, uptoMs: number): void {
	while ((sim.scheduler.peek()?.time ?? Infinity) <= uptoMs) {
		sim.processEvent(sim.scheduler.nextEvent()!)
	}
	sim.scheduler.advanceTo(uptoMs)
}

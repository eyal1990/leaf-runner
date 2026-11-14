// An operator stop interrupts only model invocations, never the job's other stages.
export class AgentsStopped extends Error {
  constructor() { super('Agents stopped by operator'); }
}

/** A single process's signer queue. This is deliberately not a distributed budget/lock. */
export class SponsorCoordinator {
  private tail: Promise<unknown> = Promise.resolve();
  private jobs = new Map<string, Promise<unknown>>();

  run<T>(address: string, operation: () => Promise<T>): Promise<T> {
    const id = address.toLowerCase();
    const existing = this.jobs.get(id);
    if (existing) return existing as Promise<T>;
    if (this.jobs.size >= 50) return Promise.reject(new Error("Funding is busy. Try again in a moment."));
    const run = this.tail.then(operation);
    this.jobs.set(id, run);
    const finish = () => { if (this.jobs.get(id) === run) this.jobs.delete(id); };
    this.tail = run.then(finish, finish);
    return run;
  }
}

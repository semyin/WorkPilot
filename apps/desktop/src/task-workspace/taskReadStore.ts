import type { Task, TaskState } from "../generated/contracts";

type ObservedTask = { task: Task; read: number };
type StopRequest = { token: number; acknowledgedAfter: number | null };
const terminal = new Set<TaskState>(["interrupted", "failed", "completed"]);

function compare(a: Task, b: Task) {
  return a.last_sequence - b.last_sequence || a.updated_at_ms - b.updated_at_ms;
}

/** One observed task state for every view. A cancel request is intent, never a terminal result. */
export class TaskReadStore {
  private tasks = new Map<string, ObservedTask>();
  private stops = new Map<string, StopRequest>();
  private deleted = new Set<string>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private read = 0;
  private stopToken = 0;

  version = () => this.revision;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private changed() {
    this.revision++;
    this.listeners.forEach((listener) => listener());
  }
  beginRead() {
    return ++this.read;
  }
  observe(tasks: Task[], read: number) {
    let changed = false;
    for (const task of tasks) {
      if (this.deleted.has(task.id)) continue;
      const previous = this.tasks.get(task.id);
      const order = previous ? compare(task, previous.task) : 1;
      if (order < 0 || (order === 0 && previous && read < previous.read)) continue;
      changed ||= !previous || JSON.stringify(previous.task) !== JSON.stringify(task);
      this.tasks.delete(task.id);
      this.tasks.set(task.id, { task, read });
      const stop = this.stops.get(task.id);
      if (
        stop?.acknowledgedAfter !== null &&
        stop?.acknowledgedAfter !== undefined &&
        read > stop.acknowledgedAfter &&
        terminal.has(task.state)
      ) {
        this.stops.delete(task.id);
        changed = true;
      }
    }
    // A view cache, not a second task database. Keep cancellation intents until observed settled.
    for (const id of this.tasks.keys()) {
      if (this.tasks.size <= 1024) break;
      if (!this.stops.has(id)) this.tasks.delete(id);
    }
    if (changed) this.changed();
  }
  isDeleted(id: string) {
    return this.deleted.has(id);
  }
  remove(ids: string[]) {
    for (const id of ids) {
      this.deleted.add(id);
      this.tasks.delete(id);
      this.stops.delete(id);
    }
    this.changed();
  }
  task(fallback: Task) {
    const known = this.tasks.get(fallback.id)?.task;
    return known && compare(known, fallback) >= 0 ? known : fallback;
  }
  state(task: Task): TaskState {
    return this.stops.has(task.id) ? "stopping" : this.task(task).state;
  }
  stopping(task: string) {
    return this.stops.has(task);
  }
  requestStop(task: string) {
    const token = ++this.stopToken;
    this.stops.set(task, { token, acknowledgedAfter: null });
    this.changed();
    return token;
  }
  acknowledgeStop(task: string, token: number) {
    const stop = this.stops.get(task);
    if (stop?.token === token) stop.acknowledgedAfter = this.read;
  }
  rejectStop(task: string, token: number) {
    if (this.stops.get(task)?.token !== token) return;
    this.stops.delete(task);
    this.changed();
  }
}

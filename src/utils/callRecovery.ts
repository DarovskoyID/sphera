export type CallHealth = 'connecting' | 'connected' | 'reconnecting';

/** Bounded retries, independent of the call window's mount/unmount lifecycle. */
export class CallRecovery {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deadline = 0;
  private running = false;
  private stopped = false;
  private recovering = false;
  private backgrounded = false;

  private options: {
    attempt: () => Promise<void>;
    onState: (state: CallHealth) => void;
    onFailed: () => void;
    visible?: () => boolean;
    now?: () => number;
    schedule?: typeof setTimeout;
    cancel?: typeof clearTimeout;
  };

  constructor(options: CallRecovery['options']) { this.options = options; }

  connecting() {
    if (this.stopped || this.recovering) return;
    this.recovering = true;
    this.deadline = this.now() + 45_000;
    this.options.onState('connecting');
    this.timer = (this.options.schedule ?? setTimeout)(this.tick, 10_000);
  }


  private now = () => this.options.now?.() ?? Date.now();
  private visible = () => this.options.visible?.() ?? document.visibilityState === 'visible';

  recover(resumed = false) {
    if (this.stopped) return;
    if (!this.recovering || resumed) this.deadline = this.now() + 45_000;
    this.recovering = true;
    this.options.onState('reconnecting');
    if (this.timer === null) this.tick();
  }

  suspend() { this.backgrounded = true; }

  private tick = () => {
    this.timer = null;
    if (this.stopped || !this.recovering) return;
    // A frozen/background page cannot repair camera capture or reliably run timers.
    if (!this.visible() || this.backgrounded) this.deadline = this.now() + 45_000;
    if (this.visible()) this.backgrounded = false;
    if (this.now() >= this.deadline) {
      this.stop();
      this.options.onFailed();
      return;
    }
    this.options.onState('reconnecting');
    if (!this.running) {
      this.running = true;
      void this.options.attempt().catch(() => {}).finally(() => { this.running = false; });
    }
    if (this.recovering && !this.stopped) this.timer = (this.options.schedule ?? setTimeout)(this.tick, 5_000);
  };

  connected() {
    if (this.stopped) return;
    this.recovering = false;
    this.clearTimer();
    this.options.onState('connected');
  }

  private clearTimer() {
    if (this.timer !== null) (this.options.cancel ?? clearTimeout)(this.timer);
    this.timer = null;
  }

  stop() {
    this.stopped = true;
    this.recovering = false;
    this.clearTimer();
  }
}

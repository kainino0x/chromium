// Continuous cache-busting HTTP fetch pipeline.
//
// Maintains `pipelineDepth` concurrent `fetch(url + '?stream=...')` requests in
// flight (with `cache: 'no-store'` + unique query parameters to defeat browser
// HTTP caching) and buffers up to `pipelineDepth` ready compressed payloads so
// decompression/upload starts immediately as each fetch finishes.

export class StreamingFetchPipeline {
  #assetUrl = '';
  #pipelineDepth = 4;
  #paused = false;
  #generation = 0;
  #seq = 0;
  #inFlight = 0;
  #readyQueue = [];
  #waiters = [];
  #abortController = new AbortController();

  configure({ assetUrl, pipelineDepth }) {
    const changedUrl = assetUrl !== this.#assetUrl;
    this.#assetUrl = assetUrl;
    this.#pipelineDepth = Math.max(1, pipelineDepth | 0);

    if (changedUrl) {
      this.reset();
    } else {
      this.#pump();
    }
  }

  setPaused(paused) {
    this.#paused = paused;
    if (!paused) {
      this.#pump();
    }
  }

  get inFlightCount() {
    return this.#inFlight;
  }

  get readyCount() {
    return this.#readyQueue.length;
  }

  reset() {
    this.#generation++;
    this.#abortController.abort();
    this.#abortController = new AbortController();
    this.#inFlight = 0;
    this.#readyQueue.length = 0;
    this.#pump();
  }

  async nextPayload() {
    this.#pump();
    if (this.#readyQueue.length > 0) {
      const item = this.#readyQueue.shift();
      this.#pump();
      return item;
    }
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
      this.#pump();
    });
  }

  #pump() {
    if (this.#paused || !this.#assetUrl) {
      return;
    }
    const maxBuffered = this.#pipelineDepth * 2;
    while (
      this.#inFlight < this.#pipelineDepth &&
      this.#readyQueue.length + this.#inFlight < maxBuffered
    ) {
      this.#startOneFetch(this.#generation, this.#abortController.signal);
    }
  }

  async #startOneFetch(gen, signal) {
    this.#inFlight++;
    const seq = ++this.#seq;
    const t0 = performance.now();
    const sep = this.#assetUrl.includes('?') ? '&' : '?';
    const url = `${this.#assetUrl}${sep}stream=${seq}&t=${Math.random().toString(36).slice(2)}`;

    try {
      const resp = await fetch(url, { cache: 'no-store', signal });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} fetching ${url}`);
      }
      const ab = await resp.arrayBuffer();
      if (gen !== this.#generation) {
        return;
      }
      const fetchMs = performance.now() - t0;
      const payload = {
        seq,
        bytes: new Uint8Array(ab),
        fetchMs,
      };
      this.#inFlight--;

      if (this.#waiters.length > 0) {
        const waiter = this.#waiters.shift();
        waiter.resolve(payload);
      } else {
        this.#readyQueue.push(payload);
      }
      this.#pump();
    } catch (err) {
      if (gen !== this.#generation || err?.name === 'AbortError') {
        return;
      }
      this.#inFlight--;
      if (this.#waiters.length > 0) {
        const waiter = this.#waiters.shift();
        waiter.reject(err);
      } else {
        throw err;
      }
    }
  }
}

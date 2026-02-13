/**
 * Shared AbortController management for provider adapters.
 * Tracks active requests and handles cancellation + signal wiring.
 */

export class RequestTracker {
  private activeRequests = new Map<string, AbortController>();

  /**
   * Track a new request. Creates an AbortController and optionally wires
   * an external signal to abort it.
   * Returns the AbortController for the request.
   */
  track(requestId: string, signal?: AbortSignal): AbortController {
    const controller = new AbortController();
    this.activeRequests.set(requestId, controller);

    if (signal) {
      signal.addEventListener('abort', () => controller.abort());
    }

    return controller;
  }

  /**
   * Remove a completed request from tracking.
   */
  remove(requestId: string): void {
    this.activeRequests.delete(requestId);
  }

  /**
   * Cancel a specific request by ID.
   */
  cancel(requestId: string): void {
    const controller = this.activeRequests.get(requestId);
    if (controller) {
      controller.abort();
      this.activeRequests.delete(requestId);
    }
  }

  /**
   * Cancel all active requests (used during dispose).
   */
  cancelAll(): void {
    for (const controller of this.activeRequests.values()) {
      controller.abort();
    }
    this.activeRequests.clear();
  }
}

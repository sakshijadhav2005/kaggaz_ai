import type { LlmClient } from '../interfaces';

/** What the router needs from the on-device model. */
export interface LocalLlm {
  isInstalled(): boolean;
  complete(prompt: string): Promise<string>;
}

/**
 * One Gemma 4 for the whole app. Online it uses the hosted model (31B). With no connection or key,
 * or if the hosted call fails, it uses Gemma 4 on the device when that is installed.
 */
export class RoutedLlmClient implements LlmClient {
  constructor(
    private hosted: LlmClient,
    private local: LocalLlm | null,
    private canUseHosted: () => boolean,
  ) {}

  /** True when some Gemma 4 can answer right now. */
  available(): boolean {
    return this.canUseHosted() || !!this.local?.isInstalled();
  }

  async complete(prompt: string): Promise<string> {
    let hostedError: unknown;
    if (this.canUseHosted()) {
      try {
        return await this.hosted.complete(prompt);
      } catch (e) {
        hostedError = e;
      }
    }
    if (this.local?.isInstalled()) return this.local.complete(prompt);
    throw hostedError ?? new Error('Gemma 4 is not available. Go online and add an API key, or download offline Gemma 4 in Settings.');
  }

  /** Images are read by the hosted model only. */
  async completeWithImage(prompt: string, base64: string, mimeType: string): Promise<string> {
    if (!this.canUseHosted()) throw new Error('Reading images needs an internet connection and an API key.');
    return this.hosted.completeWithImage(prompt, base64, mimeType);
  }
}

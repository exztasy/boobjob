import type { Client } from 'discord.js';
import type { Logger } from '../logger.js';
import type { RegionOption } from '../ui/prompts.js';

const REFRESH_AFTER_MS = 60 * 60_000;

/** The voice regions Discord currently offers. The list rarely changes, so it is cached. */
export class RegionService {
  private cached: { at: number; regions: RegionOption[] } | null = null;
  private inFlight: Promise<RegionOption[]> | null = null;

  constructor(
    private readonly client: Client,
    private readonly log: Logger,
  ) {}

  async list(): Promise<RegionOption[]> {
    if (this.cached && Date.now() - this.cached.at < REFRESH_AFTER_MS) return this.cached.regions;
    this.inFlight ??= this.fetch().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Whether a region id can be used; unknown when the list could not be loaded, in which case Discord decides. */
  async isKnown(regionId: string): Promise<boolean> {
    const regions = await this.list();
    return regions.length === 0 || regions.some((region) => region.id === regionId);
  }

  private async fetch(): Promise<RegionOption[]> {
    try {
      const fetched = await this.client.fetchVoiceRegions();
      const regions = [...fetched.values()]
        .filter((region) => !region.deprecated && !region.custom)
        .map((region) => ({ id: region.id, name: region.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      this.cached = { at: Date.now(), regions };
      return regions;
    } catch (error) {
      this.log.warn('Could not load the list of voice regions', error);
      // Stale is better than nothing; with nothing, only "Automatic" is offered.
      return this.cached?.regions ?? [];
    }
  }
}

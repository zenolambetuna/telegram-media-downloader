import { ProviderCapabilities } from '../../types/provider';

const BASE_CAPABILITIES: ProviderCapabilities = {
  supportsVideo: false,
  supportsAudio: false,
  supportsPlaylist: false,
  supportsShorts: false,
  supportsReels: false,
  supportsStories: false,
  supportsLive: false,
  supportsPrivate: false,
  supportsAgeRestricted: false,
  supportsLogin: false,
};

/**
 * Builds a full capabilities object from a partial override. Anything not
 * specified defaults to false, so providers only declare what they truly do.
 */
export function defineCapabilities(overrides: Partial<ProviderCapabilities>): ProviderCapabilities {
  return { ...BASE_CAPABILITIES, ...overrides };
}

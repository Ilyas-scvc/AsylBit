/**
 * Smooth media clock. `HTMLMediaElement.currentTime` is the source of truth. Some browsers
 * update it in coarse steps; between updates we extrapolate with the wall clock so visuals
 * move smoothly, and re-anchor as soon as the element reports a new value. Extrapolation
 * only starts once the media time is really advancing, so the start-up delay after
 * play() or a seek never runs the clock ahead of the audio.
 */
export class PlaybackClock {
  private anchorMedia = 0;
  private anchorWall = 0;
  private lastReported = -1;
  private lastReturned = 0;
  private advancing = false;

  /** `media` = element.currentTime, `wall` = performance.now() in ms. */
  read(media: number, wall: number, playing: boolean, rate = 1): number {
    if (!playing) {
      this.reset(media, wall);
      return media;
    }
    if (media !== this.lastReported) {
      if (media > this.lastReported && this.lastReported >= 0) this.advancing = true;
      this.anchor(media, wall);
    }
    if (!this.advancing) {
      this.lastReturned = media;
      return media;
    }
    let t = this.anchorMedia + ((wall - this.anchorWall) / 1000) * rate;
    // never run far ahead of what the element reported
    if (t > media + 0.06) t = media + 0.06;
    // stay monotonic for small corrections, but follow real jumps (seek / loop)
    if (t < this.lastReturned && this.lastReturned - t < 0.1) t = this.lastReturned;
    this.lastReturned = t;
    return t;
  }

  reset(media: number, wall: number): void {
    this.anchor(media, wall);
    this.lastReturned = media;
    this.advancing = false;
  }

  private anchor(media: number, wall: number): void {
    this.anchorMedia = media;
    this.anchorWall = wall;
    this.lastReported = media;
  }
}

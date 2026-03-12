type RateSample = {
  timestamp: number
  rate: number
}

/**
 * ETA Estimator - calculates time remaining based on progress over time
 * Uses a rolling window of rate samples with average for smoothing
 */
export class EtaEstimator {
  private samples: RateSample[]
  private lastValue: number
  private lastTime: number
  private readonly maxValue: number
  private readonly windowMs: number
  private readonly enoughDataMs: number

  constructor(maxValue = 100, windowSeconds = 30, enoughDataSeconds = 5) {
    this.samples = []
    this.lastValue = 0
    this.lastTime = 0
    this.maxValue = maxValue
    this.windowMs = windowSeconds * 1000
    this.enoughDataMs = enoughDataSeconds * 1000
  }

  reset(): void {
    this.samples = []
    this.lastValue = 0
    this.lastTime = 0
  }

  update(currentValue: number): number | null {
    const now = Date.now()

    if (this.lastTime === 0) {
      this.lastValue = currentValue
      this.lastTime = now
      return null
    }

    if (currentValue <= this.lastValue) {
      this.reset()
      this.lastValue = currentValue
      this.lastTime = now
      return null
    }

    const valueChange = currentValue - this.lastValue
    const timeElapsedSeconds = (now - this.lastTime) / 1000

    this.lastValue = currentValue
    this.lastTime = now

    if (timeElapsedSeconds <= 0 || valueChange <= 0) {
      return null
    }

    this.addSample(now, valueChange / timeElapsedSeconds)
    this.pruneOldSamples(now)

    const rate = this.calculateAverageRate()
    if (rate === null) {
      return null
    }

    const remainingValue = this.maxValue - currentValue
    return remainingValue / rate
  }

  updateAndEstimate(currentValue: number): string {
    const etaSeconds = this.update(currentValue)

    if (!this.hasEnoughData()) {
      return '--'
    }

    return this.formatTime(etaSeconds)
  }

  private addSample(timestamp: number, rate: number): void {
    this.samples.push({ timestamp, rate })
  }

  private pruneOldSamples(now: number): void {
    const cutoff = now - this.windowMs
    this.samples = this.samples.filter((s) => s.timestamp >= cutoff)
  }

  private hasEnoughData(): boolean {
    if (this.samples.length < 2) {
      return false
    }
    const oldestTimestamp = this.samples[0].timestamp
    const newestTimestamp = this.samples[this.samples.length - 1].timestamp
    return newestTimestamp - oldestTimestamp >= this.enoughDataMs
  }

  private calculateAverageRate(): number | null {
    if (this.samples.length === 0) {
      return null
    }

    const sum = this.samples.reduce((acc, s) => acc + s.rate, 0)
    return sum / this.samples.length
  }

  private formatTime(seconds: number | null): string {
    if (seconds === null || !isFinite(seconds) || seconds < 0) {
      return '--'
    }

    const totalSeconds = Math.round(seconds)
    const hours = Math.floor(totalSeconds / 3600)
    const mins = Math.floor((totalSeconds % 3600) / 60)
    const secs = totalSeconds % 60

    if (hours > 0) return `${hours}h ${mins}m ${secs}s`
    if (mins > 0) return `${mins}m ${secs}s`
    return `${secs}s`
  }
}

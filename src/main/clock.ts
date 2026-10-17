// 混合邏輯時鐘：兩台電腦的系統時間不一致時，仍能正確判斷哪個修改比較晚。
// 時間戳格式「毫秒-計數-裝置編號」，固定長度補零，可以直接用字串比較大小。

const pad = (n: number, len: number): string => String(n).padStart(len, '0')

export class Clock {
  private ms = 0
  private counter = 0

  constructor(private device: string) {}

  now(): string {
    const t = Date.now()
    if (t > this.ms) {
      this.ms = t
      this.counter = 0
    } else {
      this.counter++
    }
    return `${pad(this.ms, 15)}-${pad(this.counter, 6)}-${this.device}`
  }

  /** 看到其他電腦的時間戳後往前推，確保之後產生的時間戳一定比它晚 */
  observe(ts: string): void {
    const [ms, counter] = ts.split('-').map(Number)
    if (ms > this.ms || (ms === this.ms && counter > this.counter)) {
      this.ms = ms
      this.counter = counter
    }
  }
}


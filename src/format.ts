// Spend per request is a fraction of a cent, so spend keeps 4 decimals; balances keep 2.
export const money = (value: number) => `$${value.toFixed(4)}`
export const balance = (value: number) => `$${value.toFixed(2)}`
export const count = (value: number) => value.toLocaleString('en-US')

// hourCycle h23, not hour12: false, which prints midnight as 24:00 in V8.
export const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })

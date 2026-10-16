import { timerMs } from './env';

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, timerMs(ms)));

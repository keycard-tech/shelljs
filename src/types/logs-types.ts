export interface Log {
  type: string;
  message?: string;
  data?: any;
  // unique amount all logs
  id: string;
  // date of the log
  date: Date;
}

export type Unsubscribe = () => void;
export type Subscriber = (arg0: Log) => void;
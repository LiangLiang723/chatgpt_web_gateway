export interface AssistantSnapshot {
  exists: boolean;
  text: string;
  completionMarkerPresent: boolean;
}

export interface StreamClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

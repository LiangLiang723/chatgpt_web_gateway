import { Type } from 'typebox';
import type { Static } from 'typebox';

export const AppConfigSchema = Type.Object(
  {
    host: Type.String({ minLength: 1 }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    gatewayApiKey: Type.String({ minLength: 1 }),
    uiMode: Type.Union([Type.Literal('headless'), Type.Literal('novnc')]),
    puid: Type.Integer({ minimum: 1 }),
    pgid: Type.Integer({ minimum: 1 }),
    dataDir: Type.String({ minLength: 1 }),
    maxActivePages: Type.Integer({ minimum: 1, maximum: 32 }),
    pageIdleTimeoutMinutes: Type.Integer({ minimum: 1, maximum: 1440 }),
    chatgptProxyServer: Type.Optional(Type.String({ minLength: 1 })),
    novncPort: Type.Integer({ minimum: 1, maximum: 65535 }),
    novncPassword: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export type AppConfig = Static<typeof AppConfigSchema>;

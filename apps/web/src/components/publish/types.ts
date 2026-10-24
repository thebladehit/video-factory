import type { inferOutput, TRPCOptionsProxy } from '@trpc/tanstack-react-query';
import type { AppRouter } from '@vf/api';

/** Типи відповідей `publish.*` так, як їх бачить клієнт (дати — рядки) */
type Publish = TRPCOptionsProxy<AppRouter>['publish'];
export type AccountRow = inferOutput<Publish['accounts']['list']>['accounts'][number];
export type VersionRow = inferOutput<Publish['versions']>[number];
export type PublicationRow = inferOutput<Publish['list']>[number];

import { dispatch, makeBus, subscribe } from './bus';
import type { Trigger } from './core';

type Json = Record<string, unknown>;

type AlertStatus = 'firing' | 'resolved';

interface GrafanaAlert {
  status: AlertStatus;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  generatorURL?: string;
  fingerprint?: string;
  values?: Json;
}

interface GrafanaAlertEvent extends GrafanaAlert {
  groupKey?: string;
  externalURL?: string;
}

interface GrafanaWebhookPayload {
  receiver?: string;
  status?: AlertStatus;
  alerts?: GrafanaAlert[];
  groupLabels?: Record<string, string>;
  commonLabels?: Record<string, string>;
  commonAnnotations?: Record<string, string>;
  externalURL?: string;
  version?: string;
  groupKey?: string;
}

class GrafanaReceiver {
  private alertBus = makeBus<GrafanaAlertEvent>();

  alert(opts?: { status?: AlertStatus }): Trigger<GrafanaAlertEvent> {
    const bus = this.alertBus;
    const status = opts?.status;
    return {
      name: 'grafana:alert',
      start: (emit) =>
        subscribe(
          bus,
          emit,
          status ? (e): boolean => e.status === status : undefined,
        ),
    };
  }

  handle = async (req: Request): Promise<Response> => {
    let payload: GrafanaWebhookPayload;
    try {
      payload = (await req.json()) as GrafanaWebhookPayload;
    } catch {
      return new Response('invalid json', { status: 400 });
    }
    for (const alert of payload.alerts ?? []) {
      dispatch(this.alertBus, {
        ...alert,
        groupKey: payload.groupKey,
        externalURL: payload.externalURL,
      });
    }
    return new Response('ok', { status: 200 });
  };
}

function grafanaTrigger(): GrafanaReceiver {
  return new GrafanaReceiver();
}

export {
  grafanaTrigger,
  GrafanaReceiver,
  type AlertStatus,
  type GrafanaAlert,
  type GrafanaAlertEvent,
  type GrafanaWebhookPayload,
};

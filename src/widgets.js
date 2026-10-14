// -----------------------------------------------------------------------------
// Dashboard widget "Electrolux appliances": what is running, and for how long.
//
// One row per appliance of interest (washing, drying, dishes, an oven:
// running, waiting for a delayed start, paused, in alarm, just finished,
// ready to start), the busiest first: its program and phase, when it should
// end, and a badge with the time left or the state. Nothing running: one
// line says so. Read only: commands stay with the device features and the
// scene action.
//
// Pre-localized from the language Gladys sends with each request (the core
// caches per language). Refreshed every minute (the time left moves), and
// nudged by the hub when an appliance starts, stops or changes state.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import {
  NO_VALUE,
  clockTime,
  cycleTiming,
  idsOf,
  isConnected,
  programText,
  statusKey,
  statusText,
} from './appliances.js';
import { readPath } from './capabilities.js';
import { CYCLE_FAMILIES } from './electrolux/constants.js';
import { WIDGET_KEY } from './hub.js';
import { PHASE_TEXT, WIDGET_TEXT, fill, pickLanguage } from './i18n.js';

/** Rows the widget can show (card-list, list display). */
export const MAX_ROWS = 8;

/** "42 min" or "1 h 05". */
export function formatMinutes(minutes) {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) {
    return `${total} min`;
  }
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')}`;
}

/** Order of the rows: running first, then waiting, paused, alarm, finished, ready. */
const RANK = {
  RUNNING: 0,
  DELAYED_START: 1,
  PAUSED: 2,
  ALARM: 3,
  END_OF_CYCLE: 4,
  READY_TO_START: 5,
};

const minutesLeft = (appliance) => {
  const { left } = cycleTiming(appliance);
  return left !== null && left > 0 ? left / 60 : null;
};

function badgeOf(appliance, lang) {
  const text = WIDGET_TEXT[lang];
  const status = statusKey(appliance);
  const left = minutesLeft(appliance);
  if (status === 'RUNNING' && left !== null) {
    return { text: formatMinutes(left), color: WIDGET_COLORS.PRIMARY };
  }
  if (status === 'ALARM') {
    return { text: text.alarm, color: WIDGET_COLORS.DANGER };
  }
  if (status === 'END_OF_CYCLE') {
    return { text: text.finished, color: WIDGET_COLORS.SUCCESS };
  }
  if (status === 'PAUSED') {
    return { text: text.paused, color: WIDGET_COLORS.WARNING };
  }
  return { text: statusText(appliance, lang).slice(0, 16), color: WIDGET_COLORS.INFO };
}

function subtitleOf(appliance, lang, now) {
  const text = WIDGET_TEXT[lang];
  const reported = appliance.reported;
  const program = programText(
    readPath(reported, 'userSelections/programUID') ?? readPath(reported, 'program'),
  );
  const phase = String(reported.cyclePhase ?? '').toUpperCase();
  const parts = [program, PHASE_TEXT[lang][phase]].filter((part) => part && part !== NO_VALUE);
  const { startIn, endIn } = cycleTiming(appliance);
  if (startIn) {
    parts.push(fill(text.startsIn, { d: formatMinutes(startIn / 60) }));
  }
  if (endIn) {
    parts.push(fill(text.endsAt, { t: clockTime(new Date(now + endIn * 1000), lang) }));
  }
  return parts.length > 0 ? parts.join(' · ') : statusText(appliance, lang);
}

/**
 * The widget content.
 * @param {object} options
 * @param {object} options.gladys
 * @param {ReturnType<import('./hub.js').createHub>} options.hub
 * @param {string} options.language sent by Gladys with the request
 * @param {number} [options.now]
 */
export function buildWidgetContent({ gladys, hub, language, now = Date.now() }) {
  const lang = pickLanguage(language);
  const text = WIDGET_TEXT[lang];
  const caption = (value) => ({
    ttl_seconds: 60,
    components: [{ type: 'text', variant: 'body', text: value }],
  });
  if (!hub.configured) {
    return caption(text.notConfigured);
  }
  const created = new Set((gladys.devices ?? []).map((device) => device.external_id));
  const appliances = [...hub.appliances.values()].filter((appliance) =>
    created.has(idsOf(gladys, appliance.id).device),
  );
  if (appliances.length === 0) {
    return caption(text.noDevice);
  }
  const active = appliances
    .filter((appliance) => [...CYCLE_FAMILIES, 'oven'].includes(appliance.family))
    .filter((appliance) => isConnected(appliance) && statusKey(appliance) in RANK)
    .sort(
      (a, b) =>
        RANK[statusKey(a)] - RANK[statusKey(b)] ||
        (minutesLeft(a) ?? Infinity) - (minutesLeft(b) ?? Infinity),
    );
  if (active.length === 0) {
    return caption(text.nothing);
  }
  const runningCount = active.filter((appliance) => statusKey(appliance) === 'RUNNING').length;
  const components = [];
  if (runningCount > 0) {
    components.push({
      type: 'text',
      variant: 'heading',
      text: fill(text.running, { n: runningCount }),
    });
  }
  components.push({
    type: 'card-list',
    display: 'list',
    items: active.slice(0, MAX_ROWS).map((appliance) => ({
      title: hub.displayName(appliance.id).slice(0, 60),
      subtitle: subtitleOf(appliance, lang, now),
      badge: badgeOf(appliance, lang),
    })),
  });
  return { ttl_seconds: 60, components };
}

/** Handlers of the widgets declared in the manifest, by key. */
export function createWidgets({ gladys, hub }) {
  return {
    [WIDGET_KEY]: {
      get: ({ language }) => buildWidgetContent({ gladys, hub, language }),
    },
  };
}

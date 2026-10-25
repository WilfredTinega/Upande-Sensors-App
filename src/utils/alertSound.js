/**
 * The alert tone for incoming limit breaches — the packhouse app's alert sound
 * (assets/sounds/alert.mp3) — and the switch that turns it on and off.
 *
 * Two places make the sound, and both obey the switch:
 *  - app open: `playAlertSound()` here, when the bell's unread count rises;
 *  - app closed: the Android notification channel. A channel's sound is fixed
 *    when it is created, so on/off is a choice between two channels, which the
 *    server makes per device from the preference sent with the push token.
 *
 * Per phone, not per account: it is about this device making noise.
 */

import * as SecureStore from 'expo-secure-store';

const KEY = 'upande_sensors_alert_sound';

let enabled = true;
let loaded = false;
const listeners = new Set();
let player = null;

export function isAlertSoundEnabled() {
  return enabled;
}

/** Read the saved choice once; until then the default (on) applies. */
export async function loadAlertSound() {
  if (loaded) return enabled;
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (raw === '0' || raw === '1') enabled = raw === '1';
  } catch {
    /* keep the default */
  }
  loaded = true;
  listeners.forEach((fn) => fn(enabled));
  return enabled;
}

export function setAlertSoundEnabled(next) {
  enabled = Boolean(next);
  loaded = true;
  SecureStore.setItemAsync(KEY, enabled ? '1' : '0').catch(() => {});
  listeners.forEach((fn) => fn(enabled));
}

export function subscribeToAlertSound(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Play the tone if the switch is on. Never throws: sound is not critical. */
export function playAlertSound() {
  if (!enabled) return;
  try {
    if (!player) {
      // Required lazily so a build without the native module fails here, once,
      // rather than at import time for the whole app.
      const { createAudioPlayer } = require('expo-audio');
      player = createAudioPlayer(require('../../assets/sounds/alert.mp3'));
    }
    player.seekTo(0);
    player.play();
  } catch {
    player = null;
  }
}

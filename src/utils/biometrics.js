import * as LocalAuthentication from 'expo-local-authentication';

/**
 * Thin wrapper over expo-local-authentication.
 *
 * Everything here fails closed: if the hardware, the enrolment state, or the
 * prompt itself cannot be established, the answer is "no biometrics". This
 * gates access to a stored password, so an inconclusive result must never read
 * as a successful unlock.
 */

const TYPE = LocalAuthentication.AuthenticationType;

/**
 * What the device can actually do, right now.
 *
 * `available` means hardware exists AND the user has enrolled at least one
 * credential — a phone with a fingerprint reader and no registered finger can't
 * authenticate anyone, so offering the button would be a dead end.
 */
export async function getBiometricCapability() {
  try {
    const [hasHardware, isEnrolled, types] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync(),
    ]);

    const list = Array.isArray(types) ? types : [];
    const face = list.includes(TYPE.FACIAL_RECOGNITION);
    const fingerprint = list.includes(TYPE.FINGERPRINT);
    const iris = list.includes(TYPE.IRIS);

    return {
      hasHardware,
      isEnrolled,
      available: !!hasHardware && !!isEnrolled,
      face,
      fingerprint,
      iris,
      label: describe({ face, fingerprint, iris }),
      icon: face && !fingerprint ? 'scan-outline' : 'finger-print-outline',
    };
  } catch {
    return {
      hasHardware: false,
      isEnrolled: false,
      available: false,
      face: false,
      fingerprint: false,
      iris: false,
      label: 'Biometrics',
      icon: 'finger-print-outline',
    };
  }
}

/** Name the methods the device actually offers, rather than guessing one. */
function describe({ face, fingerprint, iris }) {
  const names = [];
  if (fingerprint) names.push('Fingerprint');
  if (face) names.push('Face');
  if (iris) names.push('Iris');
  if (!names.length) return 'Biometrics';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1].toLowerCase()}`;
}

/**
 * Run the prompt. Returns `{ success, error, cancelled }`.
 *
 * `disableDeviceFallback: false` lets the user fall back to the device PIN or
 * pattern — on Android a wet or unrecognised finger is common enough that
 * blocking the fallback would strand people who can still prove they own the
 * phone.
 */
export async function promptBiometric(reason = 'Unlock Upande Sensors') {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: 'Use password',
      fallbackLabel: 'Use device PIN',
      disableDeviceFallback: false,
    });

    if (result.success) return { success: true };
    const error = result.error || 'unknown';
    return {
      success: false,
      cancelled: error === 'user_cancel' || error === 'system_cancel' || error === 'app_cancel',
      error,
    };
  } catch (err) {
    return { success: false, cancelled: false, error: err?.message || 'unknown' };
  }
}

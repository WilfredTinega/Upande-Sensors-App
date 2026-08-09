import React, { useState } from 'react';
import { Image, Text, View } from 'react-native';

import { client } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useTheme, radius, type } from '../hooks/useTheme';
import { font } from '../theme';

/** "Jane Doe" → JD; "jane@upande.com" → JA. Never more than two characters. */
export function initialsOf(fullName, fallback) {
  const source = String(fullName || '').trim();
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    if (parts[0].length >= 2) return parts[0].slice(0, 2).toUpperCase();
    if (parts[0]) return parts[0][0].toUpperCase();
  }
  // Fall back to the account name, minus the domain.
  const local = String(fallback || '').split('@')[0];
  return local ? local.slice(0, 2).toUpperCase() : '?';
}

/**
 * The signed-in user's ERPNext avatar, or their initials.
 *
 * The image is fetched with the session cookie attached explicitly: this app
 * keeps `sid` itself rather than relying on the platform cookie jar, and
 * `Image` does not share the client's headers — without this a private
 * `user_image` would silently 404 into the fallback.
 */
export function UserAvatar({ size = 26, focused, color }) {
  const t = useTheme();
  const { user, baseUrl } = useAuth();
  const [failed, setFailed] = useState(false);

  const image = user?.image;
  const absolute =
    image && /^https?:\/\//i.test(image) ? image : image ? `${baseUrl}${image}` : null;

  const ring = focused ? t.accent : color || t.textMuted;

  if (absolute && !failed) {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: radius.pill,
          overflow: 'hidden',
          borderWidth: focused ? 2 : 1,
          borderColor: ring,
        }}
      >
        <Image
          source={{
            uri: absolute,
            headers: client.sid ? { Cookie: `sid=${client.sid}` } : undefined,
          }}
          style={{ width: '100%', height: '100%' }}
          resizeMode="cover"
          // A broken or forbidden image falls back to initials rather than
          // leaving an empty box where the account tab should be.
          onError={() => setFailed(true)}
        />
      </View>
    );
  }

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius.pill,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: focused ? t.accentSoft : t.surfaceSunken,
        borderWidth: focused ? 2 : 1,
        borderColor: ring,
      }}
    >
      <Text
        style={[
          type.caption,
          { color: ring, fontSize: Math.round(size * 0.42), fontFamily: font('700') },
        ]}
      >
        {initialsOf(user?.fullName, user?.name)}
      </Text>
    </View>
  );
}

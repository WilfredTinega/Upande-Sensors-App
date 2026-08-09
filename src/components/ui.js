import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme, spacing, radius, type } from '../hooks/useTheme';
import { font } from '../theme';

/* ── Surfaces ────────────────────────────────────────────────────────────── */

export function Card({ children, style, padded = true }) {
  const t = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: t.surface,
          borderRadius: radius.lg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.border,
          padding: padded ? spacing.lg : 0,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionTitle({ children, hint }) {
  const t = useTheme();
  return (
    <View style={{ marginBottom: spacing.sm }}>
      <Text style={[type.label, { color: t.textSecondary, textTransform: 'uppercase' }]}>
        {children}
      </Text>
      {hint ? (
        <Text style={[type.caption, { color: t.textMuted, marginTop: 2 }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

/* ── Buttons ─────────────────────────────────────────────────────────────── */

export function Button({ label, onPress, disabled, loading, tone = 'accent', compact, style }) {
  const t = useTheme();
  const background =
    tone === 'accent' ? t.accent : tone === 'danger' ? t.status.critical : t.surfaceSunken;
  const foreground = tone === 'ghost' ? t.textPrimary : t.onAccent;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled || !!loading }}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        {
          backgroundColor: background,
          opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
          borderRadius: radius.md,
          // `compact` is for secondary controls like pagination, where a
          // full-height button dominates the row it sits under.
          paddingVertical: compact ? 7 : 13,
          paddingHorizontal: compact ? spacing.md : spacing.lg,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: spacing.sm,
        },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={foreground} /> : null}
      <Text style={[compact ? type.caption : type.heading, { color: foreground }]}>{label}</Text>
    </Pressable>
  );
}

/* ── Inputs ──────────────────────────────────────────────────────────────── */

export function Field({ label, hint, secureTextEntry, style, ...inputProps }) {
  const t = useTheme();
  const [revealed, setRevealed] = useState(false);
  const isSecret = !!secureTextEntry;

  return (
    <View style={{ marginBottom: spacing.lg }}>
      <Text style={[type.label, { color: t.textSecondary, marginBottom: spacing.xs }]}>
        {label}
      </Text>

      {/*
        The border and radius live on this wrapper, not on the TextInput, and
        the wrapper clips its children. Android draws the autofill highlight on
        the input's own bounds — with the border on the input, that highlight
        landed as a hard rectangle over the rounded field. Clipping here forces
        it to the same rounded shape.
      */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: t.surface,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.borderStrong,
          borderRadius: radius.md,
          overflow: 'hidden',
        }}
      >
        <TextInput
          placeholderTextColor={t.textMuted}
          secureTextEntry={isSecret && !revealed}
          underlineColorAndroid="transparent"
          {...inputProps}
          // Caller style comes last so a multiline field can set its own
          // height; the base style is not overridden wholesale.
          style={[
            type.body,
            {
              flex: 1,
              backgroundColor: 'transparent',
              paddingHorizontal: spacing.md,
              paddingVertical: 12,
              color: t.textPrimary,
            },
            style,
          ]}
        />

        {isSecret ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={revealed ? 'Hide password' : 'Show password'}
            onPress={() => setRevealed((v) => !v)}
            hitSlop={10}
            style={({ pressed }) => ({
              paddingHorizontal: spacing.md,
              paddingVertical: 12,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Ionicons
              name={revealed ? 'eye-off-outline' : 'eye-outline'}
              size={19}
              color={t.textMuted}
            />
          </Pressable>
        ) : null}
      </View>

      {hint ? (
        <Text style={[type.caption, { color: t.textMuted, marginTop: spacing.xs }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

/**
 * Dropdown backed by a modal list. A modal rather than an inline expansion
 * because these lists (sensor names on a large site) run to dozens of entries
 * and would otherwise push the chart off screen.
 */
export function SelectField({
  label,
  value,
  options = [],
  onChange,
  placeholder = 'Select…',
  allowClear = false,
  clearLabel = 'All',
  disabled,
  compact,
  // 'bare' drops the box and renders as text + caret, for use in a navigation
  // header where a bordered field would sit too heavily.
  variant = 'boxed',
  /**
   * Server-side search. When given, typing queries the source rather than
   * filtering the options already fetched — necessary for lists longer than one
   * page, where local filtering would silently search only the first slice.
   */
  onSearch,
  searching,
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  // Held in a ref so a parent that recreates the callback each render doesn't
  // retrigger the search on every keystroke's re-render.
  const searchRef = useRef(onSearch);
  searchRef.current = onSearch;

  useEffect(() => {
    if (!open || !searchRef.current) return undefined;
    const delay = query.trim() ? 250 : 0;
    const id = setTimeout(() => searchRef.current(query.trim()), delay);
    return () => clearTimeout(id);
  }, [query, open]);

  const normalised = useMemo(
    () => options.map((o) => (typeof o === 'string' ? { label: o, value: o } : o)),
    [options],
  );

  const filtered = useMemo(() => {
    // With server-side search the incoming options are already the result;
    // filtering them again would drop matches the server just found.
    if (onSearch || !query.trim()) return normalised;
    const q = query.trim().toLowerCase();
    return normalised.filter((o) => String(o.label).toLowerCase().includes(q));
  }, [normalised, query, onSearch]);

  const selected = normalised.find((o) => o.value === value);
  const searchable = !!onSearch || normalised.length > 8;

  return (
    <View
      style={
        // The bare variant sits inside a navigation header: it must size to its
        // content and centre on the cross axis, not stretch or carry the
        // form-field bottom margin.
        variant === 'bare'
          ? { alignSelf: 'center', flexShrink: 1 }
          : { flex: compact ? 1 : undefined, marginBottom: compact ? 0 : spacing.lg }
      }
    >
      {label ? (
        <Text style={[type.label, { color: t.textSecondary, marginBottom: spacing.xs }]}>
          {label}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label || 'Select'}: ${selected?.label || placeholder}`}
        // A searchable field must stay open-able when empty — that is exactly
        // when you need to type to find something.
        disabled={disabled || (!onSearch && !normalised.length)}
        onPress={() => setOpen(true)}
        style={({ pressed }) => ({
          backgroundColor: variant === 'bare' ? 'transparent' : t.surface,
          borderWidth: variant === 'bare' ? 0 : StyleSheet.hairlineWidth,
          borderColor: t.borderStrong,
          borderRadius: radius.md,
          paddingHorizontal: variant === 'bare' ? 0 : spacing.md,
          paddingVertical: variant === 'bare' ? 6 : 11,
          opacity: disabled || !normalised.length ? 0.5 : pressed ? 0.6 : 1,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: variant === 'bare' ? 'flex-end' : 'space-between',
          gap: 4,
        })}
      >
        <Text
          numberOfLines={1}
          style={[
            variant === 'bare' ? type.caption : type.body,
            {
              color: variant === 'bare' ? t.accent : selected ? t.textPrimary : t.textMuted,
              fontWeight: variant === 'bare' ? '600' : '400',
              fontFamily: variant === 'bare' ? font('600') : font('400'),
              flexShrink: 1,
              flex: variant === 'bare' ? undefined : 1,
            },
          ]}
        >
          {selected?.label || (allowClear && !value ? clearLabel : placeholder)}
        </Text>
        <Text style={{ color: variant === 'bare' ? t.accent : t.textMuted, fontSize: 10 }}>▼</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          onPress={() => setOpen(false)}
          style={{ flex: 1, backgroundColor: '#00000080', justifyContent: 'flex-end' }}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              backgroundColor: t.background,
              borderTopLeftRadius: radius.lg,
              borderTopRightRadius: radius.lg,
              paddingTop: spacing.md,
              maxHeight: '70%',
            }}
          >
            <View
              style={{
                alignSelf: 'center',
                width: 36,
                height: 4,
                borderRadius: 2,
                backgroundColor: t.borderStrong,
                marginBottom: spacing.md,
              }}
            />
            <Text
              style={[
                type.heading,
                { color: t.textPrimary, paddingHorizontal: spacing.lg, marginBottom: spacing.sm },
              ]}
            >
              {label || 'Select'}
            </Text>

            {searchable ? (
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search…"
                placeholderTextColor={t.textMuted}
                autoCorrect={false}
                style={[
                  type.body,
                  {
                    marginHorizontal: spacing.lg,
                    marginBottom: spacing.sm,
                    backgroundColor: t.surface,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: t.borderStrong,
                    borderRadius: radius.md,
                    paddingHorizontal: spacing.md,
                    paddingVertical: 10,
                    color: t.textPrimary,
                  },
                ]}
              />
            ) : null}

            <FlatList
              data={allowClear ? [{ label: clearLabel, value: null }, ...filtered] : filtered}
              keyExtractor={(item, i) => `${item.value ?? 'all'}-${i}`}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingBottom: spacing.xxl }}
              renderItem={({ item }) => {
                const active = item.value === value;
                return (
                  <Pressable
                    onPress={() => {
                      onChange?.(item.value);
                      setQuery('');
                      setOpen(false);
                    }}
                    style={({ pressed }) => ({
                      paddingVertical: 14,
                      paddingHorizontal: spacing.lg,
                      backgroundColor: pressed ? t.surfaceSunken : 'transparent',
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    })}
                  >
                    <Text
                      style={[
                        type.body,
                        {
                          color: active ? t.accent : t.textPrimary,
                          fontWeight: active ? '600' : '400',
                          fontFamily: active ? font('600') : font('400'),
                        },
                      ]}
                    >
                      {item.label}
                    </Text>
                    {active ? <Text style={{ color: t.accent }}>✓</Text> : null}
                  </Pressable>
                );
              }}
              ListEmptyComponent={
                <Text
                  style={[
                    type.body,
                    { color: t.textMuted, padding: spacing.lg, textAlign: 'center' },
                  ]}
                >
                  {searching
                    ? 'Searching…'
                    : query.trim()
                      ? `Nothing matches “${query.trim()}”.`
                      : 'No one available to assign.'}
                </Text>
              }
            />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

/** Single-choice row of pills — for small, stable option sets only. */
/**
 * A row of discrete buttons, one selected.
 *
 * Distinct from `Segmented`, which paints only the selected option and leaves
 * the rest as bare text on a track — readable as a control once you know it is
 * one, but the unselected options don't announce that they can be tapped. Here
 * every option carries its own border and surface, so the whole row reads as
 * buttons at a glance.
 */
export function ChoiceButtons({ options, value, onChange, disabled, style }) {
  const t = useTheme();
  return (
    <View style={[{ flexDirection: 'row', gap: 5, opacity: disabled ? 0.5 : 1 }, style]}>
      {options.map((opt) => {
        const item = typeof opt === 'string' ? { label: opt, value: opt } : opt;
        const active = item.value === value;
        return (
          <Pressable
            key={String(item.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active, disabled: !!disabled }}
            disabled={disabled}
            onPress={() => onChange?.(item.value)}
            style={({ pressed }) => ({
              // Equal shares of the row, and never wider than the text needs.
              flex: 1,
              paddingVertical: 8,
              paddingHorizontal: 4,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: active ? t.accent : t.borderStrong,
              backgroundColor: active ? t.accent : t.surface,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.75 : 1,
            })}
          >
            <Text
              numberOfLines={1}
              // Shrinks rather than truncating: a range label ending up as
              // "60 day…" is the thing this replaced.
              adjustsFontSizeToFit
              minimumFontScale={0.85}
              style={[
                type.caption,
                {
                  color: active ? t.onAccent : t.textSecondary,
                  fontFamily: active ? font('600') : font('500'),
                },
              ]}
            >
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Segmented({ options, value, onChange, disabled, compact, style }) {
  const t = useTheme();
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          backgroundColor: t.surfaceSunken,
          borderRadius: radius.pill,
          // `compact` is for a navigation header, where the full control would
          // crowd the title beside it.
          padding: compact ? 2 : 3,
          opacity: disabled ? 0.5 : 1,
        },
        style,
      ]}
    >
      {options.map((opt) => {
        const item = typeof opt === 'string' ? { label: opt, value: opt } : opt;
        const active = item.value === value;
        return (
          <Pressable
            key={String(item.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active, disabled: !!disabled }}
            disabled={disabled}
            onPress={() => onChange?.(item.value)}
            style={{
              flex: 1,
              paddingVertical: compact ? 4 : 7,
              paddingHorizontal: compact ? 7 : 0,
              borderRadius: radius.pill,
              backgroundColor: active ? t.surface : 'transparent',
              alignItems: 'center',
            }}
          >
            <Text
              numberOfLines={1}
              style={[
                type.caption,
                {
                  color: active ? t.textPrimary : t.textSecondary,
                  fontSize: compact ? 10 : undefined,
                  fontWeight: active ? '700' : '500',
                  fontFamily: active ? font('700') : font('500'),
                },
              ]}
            >
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/* ── Data display ────────────────────────────────────────────────────────── */

/**
 * A single number with its label and unit. The value wears text ink, never a
 * series colour — the optional accent bar carries identity instead.
 */
export function StatTile({ label, value, unit, accent, selected, style }) {
  const t = useTheme();
  const empty = value === null || value === undefined || value === '';

  return (
    <View
      style={[
        {
          flex: 1,
          minWidth: 92,
          backgroundColor: selected ? t.surfaceSunken : t.surface,
          borderRadius: radius.md,
          // The series colour is carried by the border and the value itself,
          // rather than a separate swatch — the tile *is* the key.
          borderWidth: selected ? 2 : StyleSheet.hairlineWidth,
          borderColor: accent || t.border,
          paddingVertical: spacing.md,
          paddingHorizontal: spacing.md,
        },
        style,
      ]}
    >
      <Text numberOfLines={1} style={[type.label, { color: t.textSecondary }]}>
        {label}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 3, marginTop: 2 }}>
        <Text style={[type.title, { color: empty ? t.textMuted : accent || t.textPrimary }]}>
          {empty ? '—' : value}
        </Text>
        {unit && !empty ? (
          <Text style={[type.caption, { color: t.textSecondary }]}>{unit}</Text>
        ) : null}
      </View>
    </View>
  );
}

/** Status chip — icon glyph + word, so state never rests on colour alone. */
export function StatusChip({ tone = 'good', label, style }) {
  const t = useTheme();
  const colour = t.status[tone] || t.textSecondary;
  const glyph = { good: '●', warning: '▲', serious: '▲', critical: '■' }[tone] || '●';
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 5,
          paddingHorizontal: spacing.sm,
          paddingVertical: 4,
          borderRadius: radius.pill,
          backgroundColor: t.surfaceSunken,
          alignSelf: 'flex-start',
        },
        style,
      ]}
    >
      <Text style={{ color: colour, fontSize: 10 }}>{glyph}</Text>
      <Text style={[type.caption, { color: t.textPrimary }]}>{label}</Text>
    </View>
  );
}

/* ── States ──────────────────────────────────────────────────────────────── */

export function LoadingView({ label = 'Loading…' }) {
  const t = useTheme();
  return (
    <View style={{ padding: spacing.xxl, alignItems: 'center', gap: spacing.md }}>
      <ActivityIndicator color={t.accent} />
      <Text style={[type.body, { color: t.textSecondary }]}>{label}</Text>
    </View>
  );
}

export function EmptyState({ title, message, action }) {
  const t = useTheme();
  return (
    <View style={{ padding: spacing.xl, alignItems: 'center', gap: spacing.sm }}>
      <Text style={[type.heading, { color: t.textPrimary, textAlign: 'center' }]}>{title}</Text>
      {message ? (
        <Text style={[type.body, { color: t.textSecondary, textAlign: 'center', lineHeight: 20 }]}>
          {message}
        </Text>
      ) : null}
      {action ? <View style={{ marginTop: spacing.md }}>{action}</View> : null}
    </View>
  );
}

export function ErrorView({ error, onRetry }) {
  const t = useTheme();
  const message = error?.message || 'Something went wrong.';
  return (
    <View
      style={{
        margin: spacing.lg,
        padding: spacing.lg,
        borderRadius: radius.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.status.critical,
        backgroundColor: t.surface,
        gap: spacing.md,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Text style={{ color: t.status.critical, fontSize: 12 }}>■</Text>
        <Text style={[type.heading, { color: t.textPrimary }]}>Couldn’t load</Text>
      </View>
      <Text style={[type.body, { color: t.textSecondary, lineHeight: 20 }]}>{message}</Text>
      {onRetry ? <Button label="Try again" tone="ghost" onPress={onRetry} /> : null}
    </View>
  );
}

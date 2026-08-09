import React, { useEffect, useRef, useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { captureScreen } from 'react-native-view-shot';

import { Button, Field, Segmented, SelectField } from './ui';
import {
  ISSUE_KINDS,
  assignIssue,
  attachScreenshot,
  createIssue,
  searchUsers,
} from '../api/endpoints';
import { invalidate } from '../api/cache';
import { useAuth } from '../context/AuthContext';
import { useCurrentRoute } from '../navigation/ref';
import { useTheme, spacing, radius, type } from '../hooks/useTheme';
import { font } from '../theme';

/**
 * Floating report control: raise a problem or a feature request from wherever
 * you are, with a picture of what you were looking at.
 *
 * The screenshot is taken *before* the sheet opens — otherwise every report
 * would show the report form rather than the screen being reported.
 */
export function ReportButton() {
  const t = useTheme();
  const { user } = useAuth();
  const route = useCurrentRoute();

  const [open, setOpen] = useState(false);
  const [shot, setShot] = useState(null);
  const [includeShot, setIncludeShot] = useState(true);
  const [kind, setKind] = useState('issue');
  const [subject, setSubject] = useState('');
  const [details, setDetails] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(null);
  const [assignee, setAssignee] = useState(null);
  const [people, setPeople] = useState([]);
  const [loadingPeople, setLoadingPeople] = useState(false);

  const start = async () => {
    setError(null);
    setSent(null);
    try {
      const base64 = await captureScreen({ format: 'jpg', quality: 0.6, result: 'base64' });
      setShot(base64);
      setIncludeShot(true);
    } catch {
      // A refused or unsupported capture must not block the report itself.
      setShot(null);
      setIncludeShot(false);
    }
    // Loaded when the sheet opens rather than at mount: most sessions never
    // open it.
    setLoadingPeople(true);
    searchUsers('').then((rows) => {
      setPeople(rows);
      setLoadingPeople(false);
    });
    setOpen(true);
  };

  /**
   * Held so a pending auto-close can be cancelled — closing by hand, or
   * unmounting, must not leave a timer that reopens nothing and sets state on a
   * component that is gone.
   */
  const closeTimer = useRef(null);
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const close = () => {
    clearTimeout(closeTimer.current);
    setOpen(false);
    setShot(null);
    setError(null);
    setSent(null);
  };

  /**
   * Close on success, after a beat.
   *
   * Not immediately: the confirmation carries the issue number, and on the
   * partial-failure path it is the only notice that the screenshot did not go
   * with it — so that message gets longer to be read.
   */
  const closeAfterSuccess = (delay = 1200) => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setOpen(false);
      setShot(null);
      setSent(null);
    }, delay);
  };

  /**
   * Everything the form holds, cleared together.
   *
   * The three success paths each used to clear only the subject and details,
   * leaving the kind, the assignee and the previous screen's screenshot in
   * place — so a second report could quietly carry the first one's picture.
   */
  const resetForm = () => {
    setSubject('');
    setDetails('');
    setKind('issue');
    setAssignee(null);
    setShot(null);
    setIncludeShot(false);
  };

  const submit = async () => {
    if (!subject.trim() || sending) return;
    setSending(true);
    setError(null);

    try {
      // The screen name is recorded for you: "it broke" is far more useful with
      // the page attached to it.
      const created = await createIssue({
        subject,
        description: [details.trim(), route ? `Screen: ${route}` : null]
          .filter(Boolean)
          .join('\n\n'),
        kind,
        user: user?.name,
      });

      const name = created?.name;

      /**
       * Assignment and the screenshot are follow-up calls, and each can fail on
       * its own. Neither undoes a report that is already filed, so they are
       * reported as qualifications on the confirmation rather than as errors —
       * the alternative is telling someone their report failed when it didn't.
       */
      const notes = [];

      if (name && assignee) {
        try {
          await assignIssue({ issueName: name, user: assignee, description: subject.trim() });
        } catch {
          notes.push(`could not be assigned to ${assignee}`);
        }
      }

      if (name && includeShot && shot) {
        try {
          await attachScreenshot({ issueName: name, base64: shot });
        } catch {
          notes.push('screenshot could not be attached');
        }
      }

      setSent(notes.length ? `${name} — ${notes.join('; ')}` : name || 'Submitted');
      resetForm();
      // So the list on App activity shows this report the moment it is opened,
      // rather than at the end of the cache's lifetime.
      invalidate('issues');
      // A qualified confirmation is given longer to be read than a plain one.
      closeAfterSuccess(notes.length ? 3000 : 1200);
    } catch (err) {
      setError(err);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Report a problem or request a feature"
        onPress={start}
        hitSlop={12}
        style={({ pressed }) => ({
          position: 'absolute',
          right: spacing.sm,
          // Vertically centred, clear of both the header and the tab bar.
          top: '45%',
          width: 30,
          height: 30,
          borderRadius: radius.pill,
          backgroundColor: t.surface,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.borderStrong,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.7 : 0.95,
          elevation: 4,
          shadowColor: '#000',
          shadowOpacity: 0.18,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 2 },
        })}
      >
        <Ionicons name="information-circle-outline" size={17} color={t.accent} />
      </Pressable>

      <Modal visible={open} transparent animationType="slide" onRequestClose={close}>
        <KeyboardAvoidingView
          style={{ flex: 1, justifyContent: 'flex-end' }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Pressable onPress={close} style={{ flex: 1, backgroundColor: '#00000099' }} />

          <View
            style={{
              backgroundColor: t.background,
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              maxHeight: '88%',
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: spacing.lg,
                paddingTop: spacing.lg,
                paddingBottom: spacing.md,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: t.border,
              }}
            >
              <Text style={[type.title, { color: t.textPrimary, flex: 1 }]}>Report</Text>
              <Pressable accessibilityLabel="Close" onPress={close} hitSlop={10}>
                <Ionicons name="close" size={22} color={t.textMuted} />
              </Pressable>
            </View>

            <ScrollView
              contentContainerStyle={{ padding: spacing.lg }}
              keyboardShouldPersistTaps="handled"
            >
              <Segmented
                style={{ marginBottom: spacing.lg }}
                options={ISSUE_KINDS.map((k) => ({ label: k.label, value: k.value }))}
                value={kind}
                onChange={setKind}
              />

              <Field
                label="Subject"
                value={subject}
                onChangeText={(v) => {
                  setSubject(v);
                  setSent(null);
                  setError(null);
                }}
                placeholder={kind === 'feature' ? 'What should the app do?' : 'What went wrong?'}
              />

              <Field
                label="Details"
                value={details}
                onChangeText={setDetails}
                placeholder="What you expected, and what happened instead"
                multiline
                numberOfLines={4}
                style={{ minHeight: 88, textAlignVertical: 'top' }}
              />

              {/* Always shown, even when the list comes back empty — hiding
                  the field would leave no sign that assignment exists, and an
                  empty list usually means the account cannot list users rather
                  than that there are none. */}
              <SelectField
                label="Assign to"
                value={assignee}
                options={people}
                onChange={setAssignee}
                allowClear
                clearLabel="Nobody"
                placeholder="Nobody"
                onSearch={(q) => {
                  setLoadingPeople(true);
                  searchUsers(q).then((rows) => {
                    setPeople(rows);
                    setLoadingPeople(false);
                  });
                }}
                searching={loadingPeople}
              />

              {shot ? (
                <View style={{ marginBottom: spacing.lg }}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: spacing.md,
                      marginBottom: spacing.sm,
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[type.body, { color: t.textPrimary, fontFamily: font('600') }]}>
                        Attach screenshot
                      </Text>
                      <Text style={[type.caption, { color: t.textSecondary, marginTop: 2 }]}>
                        The screen you were on, attached privately
                      </Text>
                    </View>
                    <Switch
                      value={includeShot}
                      onValueChange={setIncludeShot}
                      trackColor={{ false: t.surfaceSunken, true: t.accent }}
                      thumbColor={t.surface}
                    />
                  </View>

                  {includeShot ? (
                    <Image
                      source={{ uri: `data:image/jpeg;base64,${shot}` }}
                      style={{
                        width: '100%',
                        height: 180,
                        borderRadius: radius.md,
                        borderWidth: StyleSheet.hairlineWidth,
                        borderColor: t.border,
                      }}
                      resizeMode="contain"
                    />
                  ) : null}
                </View>
              ) : (
                <Text style={[type.caption, { color: t.textMuted, marginBottom: spacing.lg }]}>
                  No screenshot could be captured on this device — the report will be sent without
                  one.
                </Text>
              )}

              {error ? (
                <Text
                  style={[
                    type.caption,
                    { color: t.status.critical, marginBottom: spacing.md, lineHeight: 17 },
                  ]}
                >
                  ■{' '}
                  {error.isPermission
                    ? 'Your account is not allowed to create issues. Ask an administrator to grant create access on Issue.'
                    : error.message}
                </Text>
              ) : null}

              {sent ? (
                <Text
                  style={[
                    type.caption,
                    { color: t.status.good, marginBottom: spacing.md, lineHeight: 17 },
                  ]}
                >
                  ● Submitted as {sent}.
                </Text>
              ) : null}

              <Button
                label={sending ? 'Sending…' : 'Submit'}
                onPress={submit}
                loading={sending}
                disabled={!subject.trim() || sending}
              />
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

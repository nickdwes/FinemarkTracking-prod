import React, { useMemo, useState } from 'react';
import { View, Pressable, StyleSheet, TextInput, FlatList, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Sheet } from './Sheet';
import { Txt } from './Text';
import { colors, font, radius, spacing } from '@/theme';

export interface Option {
  label: string;
  value: string;
}

interface SelectProps {
  label?: string;
  value: string | null;
  options: Option[];
  onChange: (value: string, option: Option) => void;
  placeholder?: string;
  required?: boolean;
  searchable?: boolean;
  disabled?: boolean;
  loading?: boolean;
  hint?: string;
}

/** Dropdown picker (RN has no <select>): a field that opens a searchable option sheet. */
export function Select({
  label,
  value,
  options,
  onChange,
  placeholder = 'Select…',
  required,
  searchable,
  disabled,
  loading,
  hint,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');

  const selected = options.find((o) => o.value === value) || null;
  const filtered = useMemo(() => {
    if (!q.trim()) return options;
    const s = q.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(s));
  }, [q, options]);

  return (
    <View style={{ marginBottom: spacing.md }}>
      {label ? (
        <Txt variant="label" style={{ marginBottom: 6 }}>
          {label}
          {required ? <Txt style={{ color: colors.cyan }}> *</Txt> : null}
        </Txt>
      ) : null}
      <Pressable
        style={[styles.field, disabled && styles.disabled]}
        onPress={() => !disabled && !loading && setOpen(true)}
      >
        <Txt variant="body" style={{ flex: 1, color: selected ? colors.text : colors.textFaint }} numberOfLines={1}>
          {loading ? 'Loading…' : selected ? selected.label : placeholder}
        </Txt>
        {loading ? (
          <ActivityIndicator size="small" color={colors.cyan} />
        ) : (
          <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
        )}
      </Pressable>
      {hint ? <Txt variant="faint" style={{ marginTop: 4 }}>{hint}</Txt> : null}

      <Sheet visible={open} onClose={() => { setOpen(false); setQ(''); }} title={label || 'Select'} scroll={false}>
        {searchable ? (
          <TextInput
            placeholder="Search…"
            placeholderTextColor={colors.textFaint}
            value={q}
            onChangeText={setQ}
            style={styles.search}
            autoFocus
          />
        ) : null}
        <FlatList
          data={filtered}
          keyExtractor={(o) => o.value}
          keyboardShouldPersistTaps="handled"
          style={{ maxHeight: 380 }}
          ListEmptyComponent={<Txt variant="muted" style={{ padding: spacing.lg }}>No options.</Txt>}
          renderItem={({ item }) => {
            const on = item.value === value;
            return (
              <Pressable
                style={[styles.option, on && styles.optionOn]}
                onPress={() => {
                  onChange(item.value, item);
                  setOpen(false);
                  setQ('');
                }}
              >
                <Txt variant="body" style={on ? { color: colors.cyan } : undefined}>{item.label}</Txt>
                {on ? <Ionicons name="checkmark" size={18} color={colors.cyan} /> : null}
              </Pressable>
            );
          }}
        />
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.glassStrong,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassBorder,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  disabled: { opacity: 0.5 },
  search: {
    backgroundColor: colors.glassStrong,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassBorder,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    color: colors.text,
    fontSize: font.size.md,
    marginBottom: spacing.sm,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.glassBorder,
  },
  optionOn: { backgroundColor: colors.cyanDim, borderRadius: radius.sm },
});

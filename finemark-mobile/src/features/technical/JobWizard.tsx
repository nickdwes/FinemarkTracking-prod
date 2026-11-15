import React, { useMemo, useState } from 'react';
import { View, StyleSheet, Pressable, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { GlassCard, Txt, NeonButton, Field, Divider, Sheet, toast } from '@/components/ui';
import { EvidencePicker, type Evidence } from './EvidencePicker';
import { TechApi, type Ticket, type CompletionBlocker } from './api';
import { colors, spacing, radius } from '@/theme';

// ── Step definitions (mirror backend STEP_CONFIG stages) ─────────────────────
type StepKey = 'checkin' | 'vehicle' | 'preInstall' | 'electrical' | 'install' | 'postInstall' | 'photos' | 'signoff';
const STEPS: { key: StepKey; title: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'checkin',     title: 'Check-In',           icon: 'location-outline' },
  { key: 'vehicle',     title: 'Vehicle',            icon: 'car-outline' },
  { key: 'preInstall',  title: 'Pre-Install',        icon: 'clipboard-outline' },
  { key: 'electrical',  title: 'Electrical',         icon: 'flash-outline' },
  { key: 'install',     title: 'Install & Activate', icon: 'hardware-chip-outline' },
  { key: 'postInstall', title: 'Post-Install',       icon: 'checkmark-done-outline' },
  { key: 'photos',      title: 'Site Photos',        icon: 'camera-outline' },
  { key: 'signoff',     title: 'Sign-off',           icon: 'create-outline' },
];

// ── Checklist item sets (mirror job-card.html) ───────────────────────────────
interface CheckDef { id: string; label: string; note?: string }
const PRE_INSTALL: CheckDef[] = [
  { id: 'pi-ignition-starter', label: 'Ignition & starter functioning', note: 'Crank engine briefly to confirm.' },
  { id: 'pi-dash-lights',      label: 'Dashboard lights functioning', note: 'Warning lights clear after startup.' },
  { id: 'pi-radio-acc',        label: 'Radio / accessories working', note: 'Test audio, USB and ACC socket.' },
  { id: 'pi-lights-horn',      label: 'Lights (full/dim/hazards/signals/reverse) & horn', note: 'Test all light modes and horn.' },
  { id: 'pi-central-lock',     label: 'Central locking (if applicable)', note: 'Mark N/A if none.' },
  { id: 'pi-windows',          label: 'Power windows (if applicable)', note: 'Mark N/A if manual windows.' },
  { id: 'pi-battery-voltage',  label: 'Battery voltage stable', note: '≥12.4V resting, ≥13.7V running.' },
  { id: 'pi-install-point',    label: 'Installation point confirmed', note: 'Agree mounting location.' },
  { id: 'pi-wiring-route',     label: 'Wiring route clear of moving parts', note: 'No hot surfaces, hinges or fans.' },
];
const ELECTRICAL: CheckDef[] = [
  { id: 'el-constant-12v',  label: 'Constant 12V wire tested', note: 'Confirm 12V constant with multimeter.' },
  { id: 'el-ignition',      label: 'Ignition wire tested', note: 'Switches on/off with the key.' },
  { id: 'el-ground',        label: 'Proper chassis ground', note: 'Sand paint; ~0Ω to chassis.' },
  { id: 'el-fused',         label: 'Inline fuse installed', note: 'On the constant power wire.' },
  { id: 'el-wiring-secured',label: 'Wiring insulated & secured', note: 'Heat shrink / tape; cable ties.' },
  { id: 'el-mounted',       label: 'Device mounted & concealed', note: 'No movement; trim refitted.' },
];
const POST_INSTALL: CheckDef[] = [
  { id: 'po-gps-lock',       label: 'GPS lock acquired (≥4 satellites)', note: 'Verify on platform.' },
  { id: 'po-server-ping',    label: 'Device pinging tracking server', note: 'Confirm live data.' },
  { id: 'po-ignition-event', label: 'Ignition on/off events received', note: 'Cycle the ignition.' },
  { id: 'po-speed-ok',       label: 'Speed readings correct', note: 'Short test drive if possible.' },
  { id: 'po-trim-replaced',  label: 'Trim & panels refitted', note: 'No loose panels.' },
  { id: 'po-wiring-secured', label: 'Wiring secured & tidy', note: 'Cable ties; no rattles.' },
  { id: 'po-customer-demo',  label: 'Customer shown live tracking', note: 'Log customer into portal.' },
  { id: 'po-docs-given',     label: 'Docs given to customer', note: 'Warranty card & user guide.' },
];
const PHOTO_SHOTS: CheckDef[] = [
  { id: 'ext-front', label: 'Exterior — Front' },
  { id: 'ext-back',  label: 'Exterior — Back' },
  { id: 'ext-right', label: 'Exterior — Right' },
  { id: 'ext-left',  label: 'Exterior — Left' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'interior',  label: 'Interior' },
  { id: 'engine-bay',label: 'Engine bay' },
  { id: 'device-loc',label: 'Device location' },
  { id: 'vin',       label: 'VIN number' },
  { id: 'engine-no', label: 'Engine number' },
];

// Tri-state values mirror job-card.html's renderChecklist exactly ('working' / 'issue'
// / 'faulty') — NOT 'pass'/'fail'/'na'. A checklist saved on one platform must render
// identically on the other; a mismatched state string here previously made a mobile
// 'fail' item (with its comment + photo) render as blank/unselected on the web job
// card, silently hiding a flagged fault. See PHOTO_SHOTS/CheckDef above for context.
type CheckState = 'working' | 'issue' | 'faulty';
type CheckRow = { id: string; label: string; state: CheckState | null; comment?: string; photos?: Evidence[] };

// Back-compat for rows saved by the old mobile-only 'pass'/'fail'/'na' scheme.
const LEGACY_STATE_MAP: Record<string, CheckState> = { pass: 'working', fail: 'issue', na: 'working' };
function normalizeState(raw: any): CheckState | null {
  if (raw === 'working' || raw === 'issue' || raw === 'faulty') return raw;
  return LEGACY_STATE_MAP[raw] ?? null;
}

/** Merge saved checklist state onto the canonical item list so progress resumes. */
function seedChecklist(defs: CheckDef[], saved: any): CheckRow[] {
  const savedItems: any[] = Array.isArray(saved) ? saved : Array.isArray(saved?.items) ? saved.items : [];
  const byId = new Map(savedItems.map((s: any) => [s.id, s]));
  return defs.map((d) => {
    const s: any = byId.get(d.id);
    const photos = Array.isArray(s?.photos) ? s.photos : s?.photo ? [s.photo] : [];
    return { id: d.id, label: d.label, state: normalizeState(s?.state), comment: s?.comment ?? '', photos };
  });
}

/** Strip Evidence down to the persisted shape before saving a checklist step. */
function serializeChecklist(rows: CheckRow[]) {
  return rows.map((r) => ({
    id: r.id, label: r.label, state: r.state, comment: r.comment || null,
    photos: (r.photos || []).map((e) => ({ url: e.url, filename: e.filename })),
  }));
}

/** stage → the first not-yet-complete step, so the wizard opens where work left off. */
function stageToStep(stage: number): number {
  if (stage >= 8) return 7;
  if (stage >= 7) return 6;
  if (stage >= 5) return 5;
  if (stage >= 4) return 4;
  if (stage >= 3) return 3;
  if (stage >= 2) return 2;
  if (stage >= 1) return 1;
  return 0;
}

export function JobWizard({ ticket, isIso, onDone }: { ticket: Ticket; isIso: boolean; onDone: () => void }) {
  const [idx, setIdx] = useState(() => stageToStep(ticket.stage ?? 0));
  const [saving, setSaving] = useState(false);

  // ── Step state (prefilled from the ticket so a partially-done job resumes) ──
  const vd = (ticket.vehicleDetails as any) || (ticket.vehicleRecord as any) || {};
  const [checkinNotes, setCheckinNotes] = useState<string>((ticket.checkinData as any)?.notes ?? '');
  // Field names here match the PATCH /:id/status `vehicleDetails` shape (colour/vin/
  // engineNo/mileage — NOT the old step-endpoint's color/chassisNumber/engineNumber/
  // odometer), since saving now goes through /status so it mirrors into
  // crm_customer_vehicles (see onNext's 'vehicle' case below). We still read legacy
  // key names as a fallback so a job saved before this fix still resumes correctly.
  const initialReg = vd.registration ?? ticket.vehicleRegistration ?? '';
  const [vehicle, setVehicle] = useState({
    registration: initialReg,
    regStatus: (vd.regStatus as 'registered' | 'not_registered') || (initialReg ? 'registered' : 'not_registered'),
    vehicleCategory: vd.vehicleCategory ?? '',
    make: vd.make ?? '', model: vd.model ?? '', modelNumber: vd.modelNumber ?? '',
    color: vd.colour ?? vd.color ?? '',
    year: String(vd.yearOfManufacture ?? vd.year ?? ''),
    fuelType: vd.fuelType ?? '', bodyType: vd.bodyType ?? '',
    chassisNumber: vd.vin ?? vd.chassisNumber ?? '', engineNumber: vd.engineNo ?? vd.engineNumber ?? '',
    mileage: String(vd.mileage ?? vd.odometer ?? ''),
  });
  const [pre, setPre]   = useState<CheckRow[]>(() => seedChecklist(PRE_INSTALL, ticket.preInstallChecklist));
  const [elec, setElec] = useState<CheckRow[]>(() => seedChecklist(ELECTRICAL, ticket.electricalChecklist));
  const [post, setPost] = useState<CheckRow[]>(() => seedChecklist(POST_INSTALL, ticket.postInstallChecklist));
  const di = (ticket.deviceInstall as any) || {};
  const [install, setInstall] = useState({
    imei: di.imei ?? '', msisdn: di.msisdn ?? '', signal: di.signal ?? '', trackerPhone: di.trackerPhone ?? '',
  });
  const [photos, setPhotos] = useState<Record<string, Evidence[]>>(() => {
    const saved = (ticket.sitePhotos as any) || {};
    const out: Record<string, Evidence[]> = {};
    for (const s of PHOTO_SHOTS) {
      const v = saved[s.id];
      out[s.id] = Array.isArray(v) ? v : v ? [v] : [];
    }
    return out;
  });

  // ── Sign-off / completion state ─────────────────────────────────────────────
  const [signoffNotes, setSignoffNotes] = useState('');
  const [jobCardPhoto, setJobCardPhoto] = useState<Evidence[]>(() =>
    ticket.jobCardPhotoUrl ? [{ url: ticket.jobCardPhotoUrl }] : []
  );
  const [blockers, setBlockers] = useState<CompletionBlocker[]>([]);
  const [canForce, setCanForce] = useState(false);
  const [forceOpen, setForceOpen] = useState(false);
  const [forceReason, setForceReason] = useState('');

  const step = STEPS[idx];
  const progress = useMemo(() => Math.round(((idx + 1) / STEPS.length) * 100), [idx]);

  // `viaStatus` routes the save through PATCH /:id/status instead of the plain
  // PATCH /:id/step/:stepKey — used only by the 'vehicle' step below, since /status
  // is the endpoint that mirrors vehicleDetails into crm_customer_vehicles (the
  // step endpoint just stores the JSON blob with no mirror at all).
  async function persist(stepKey: string, body: Record<string, any>, advance = true, opts?: { viaStatus?: boolean }) {
    setSaving(true);
    try {
      if (opts?.viaStatus) await TechApi.updateStatus(ticket.id, body);
      else await TechApi.saveStep(ticket.id, stepKey, body);
      toast.success(`${step.title} saved`);
      onDone();
      if (advance) setIdx((i) => Math.min(i + 1, STEPS.length - 1));
    } catch (e: any) {
      toast.error(e?.message || 'Could not save this step');
    } finally {
      setSaving(false);
    }
  }

  const back = () => setIdx((i) => Math.max(0, i - 1));

  // ── Per-step "next" handler ─────────────────────────────────────────────────
  const onNext = () => {
    switch (step.key) {
      case 'checkin':
        return persist('checkin', { notes: checkinNotes.trim() || null, confirmedAt: new Date().toISOString() });
      case 'vehicle':
        // Saved via /status (not /step/vehicle) with the field names the backend
        // actually reads (colour/vin/engineNo/mileage, plus regStatus/vehicleCategory/
        // fuelType/bodyType/modelNumber) so Customer 360's crm_customer_vehicles gets
        // mirrored the same way job-card.html's save does. `stage: 2` matches
        // STEP_CONFIG.vehicle.nextStage so the wizard's own resume logic still works.
        return persist('vehicle', {
          vehicleDetails: {
            registration: vehicle.registration.trim() || null,
            regStatus: vehicle.regStatus,
            vehicleCategory: vehicle.vehicleCategory.trim() || null,
            make: vehicle.make.trim() || null, model: vehicle.model.trim() || null,
            modelNumber: vehicle.modelNumber.trim() || null,
            colour: vehicle.color.trim() || null,
            year: vehicle.year.trim() || null,
            fuelType: vehicle.fuelType.trim() || null,
            bodyType: vehicle.bodyType.trim() || null,
            mileage: vehicle.mileage.trim() || null,
            vin: vehicle.chassisNumber.trim() || null,
            engineNo: vehicle.engineNumber.trim() || null,
          },
          stage: 2,
        }, true, { viaStatus: true });
      case 'preInstall': {
        if (pre.some((r) => r.state === null)) return toast.error('Mark every item before continuing');
        return persist('preInstall', { items: serializeChecklist(pre) });
      }
      case 'electrical': {
        if (elec.some((r) => r.state === null)) return toast.error('Mark every item before continuing');
        return persist('electrical', { items: serializeChecklist(elec) });
      }
      case 'install': {
        if (!install.imei.trim()) return toast.error('Confirm the device IMEI');
        return persist('install', {
          imei: install.imei.trim(), msisdn: install.msisdn.trim() || null,
          signal: install.signal.trim() || null, trackerPhone: install.trackerPhone.trim() || null,
        });
      }
      case 'postInstall': {
        if (post.some((r) => r.state === null)) return toast.error('Mark every item before continuing');
        return persist('postInstall', { items: serializeChecklist(post) });
      }
      case 'photos': {
        const shots: Record<string, { url: string; filename?: string }[]> = {};
        for (const s of PHOTO_SHOTS) shots[s.id] = (photos[s.id] || []).map((e) => ({ url: e.url, filename: e.filename }));
        return persist('photos', { shots });
      }
      case 'signoff':
        return; // handled by explicit buttons in the step body
    }
  };

  // Mirrors job-card.html's closeInstallation(force) — sends the same
  // {status:'Completed', stage:10[, forceComplete, overrideReason]} shape and
  // reacts to the same 422 COMPLETION_BLOCKED { blockers, canForceComplete } body.
  async function attemptComplete(force: boolean, reason?: string) {
    setSaving(true);
    try {
      const body: Record<string, any> = { status: 'Completed', stage: 10 };
      if (force) { body.forceComplete = true; body.overrideReason = reason; }
      await TechApi.updateStatus(ticket.id, body);
      setBlockers([]);
      toast.success('Job completed');
      onDone();
    } catch (e: any) {
      if (e?.code === 'COMPLETION_BLOCKED') {
        const list: CompletionBlocker[] = e?.details?.blockers || [];
        setBlockers(list);
        setCanForce(!!e?.details?.canForceComplete);
        toast.error(list.length ? `${list.length} requirement(s) not met — see below` : (e?.message || 'Job cannot be completed yet'));
      } else {
        toast.error(e?.message || 'Failed');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <GlassCard neon>
      {/* Header + progress */}
      <View style={styles.headRow}>
        <View style={styles.stepIcon}><Ionicons name={step.icon} size={18} color={colors.cyan} /></View>
        <View style={{ flex: 1 }}>
          <Txt variant="faint">Step {idx + 1} of {STEPS.length}</Txt>
          <Txt variant="heading">{step.title}</Txt>
        </View>
      </View>
      <View style={styles.track}><View style={[styles.fill, { width: `${progress}%` }]} /></View>
      {/* Step dots */}
      <View style={styles.dots}>
        {STEPS.map((s, i) => (
          <Pressable key={s.key} onPress={() => setIdx(i)} hitSlop={6}>
            <View style={[styles.dot, i === idx && styles.dotActive, i < idx && styles.dotDone]} />
          </Pressable>
        ))}
      </View>

      <Divider spacer={spacing.md} />

      {/* Step body */}
      <View style={{ gap: spacing.sm }}>
        {step.key === 'checkin' && (
          <>
            <Txt variant="muted">Confirm you are on site and ready to begin the installation.</Txt>
            <Field label="Check-in notes (optional)" placeholder="Anything worth noting on arrival…"
              value={checkinNotes} onChangeText={setCheckinNotes} multiline numberOfLines={3}
              style={{ minHeight: 72, textAlignVertical: 'top' }} />
          </>
        )}

        {step.key === 'vehicle' && (
          <>
            <View>
              <Txt variant="label" style={{ marginBottom: spacing.xs }}>Registration status</Txt>
              <View style={styles.row2}>
                {(['registered', 'not_registered'] as const).map((s) => {
                  const on = vehicle.regStatus === s;
                  return (
                    <Pressable key={s} onPress={() => setVehicle({ ...vehicle, regStatus: s })}
                      style={[styles.opt, on && { borderColor: colors.cyan, backgroundColor: colors.cyanDim }]}>
                      <Txt variant="faint" style={on ? { color: colors.cyan, fontWeight: '700' } : undefined}>
                        {s === 'registered' ? 'Registered' : 'Not registered'}
                      </Txt>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            <Field label="Registration" placeholder="KDG 123A" autoCapitalize="characters"
              value={vehicle.registration} onChangeText={(v) => setVehicle({ ...vehicle, registration: v })} />
            <View style={styles.row2}>
              <Field label="Make" placeholder="Toyota" value={vehicle.make} onChangeText={(v) => setVehicle({ ...vehicle, make: v })} style={styles.half} />
              <Field label="Model" placeholder="Hilux" value={vehicle.model} onChangeText={(v) => setVehicle({ ...vehicle, model: v })} style={styles.half} />
            </View>
            <View style={styles.row2}>
              <Field label="Vehicle Category" placeholder="motor_vehicle" value={vehicle.vehicleCategory} onChangeText={(v) => setVehicle({ ...vehicle, vehicleCategory: v })} style={styles.half} />
              <Field label="Model Number" placeholder="Trim / variant" value={vehicle.modelNumber} onChangeText={(v) => setVehicle({ ...vehicle, modelNumber: v })} style={styles.half} />
            </View>
            <View style={styles.row2}>
              <Field label="Colour" placeholder="White" value={vehicle.color} onChangeText={(v) => setVehicle({ ...vehicle, color: v })} style={styles.half} />
              <Field label="Year" placeholder="2021" keyboardType="number-pad" value={vehicle.year} onChangeText={(v) => setVehicle({ ...vehicle, year: v })} style={styles.half} />
            </View>
            <View style={styles.row2}>
              <Field label="Fuel Type" placeholder="Petrol / Diesel / …" value={vehicle.fuelType} onChangeText={(v) => setVehicle({ ...vehicle, fuelType: v })} style={styles.half} />
              <Field label="Body Type" placeholder="Saloon / SUV / …" value={vehicle.bodyType} onChangeText={(v) => setVehicle({ ...vehicle, bodyType: v })} style={styles.half} />
            </View>
            <Field label="Chassis / VIN" placeholder="Chassis or VIN" autoCapitalize="characters"
              value={vehicle.chassisNumber} onChangeText={(v) => setVehicle({ ...vehicle, chassisNumber: v })} />
            <View style={styles.row2}>
              <Field label="Engine No." placeholder="Engine number" value={vehicle.engineNumber} onChangeText={(v) => setVehicle({ ...vehicle, engineNumber: v })} style={styles.half} />
              <Field label="Mileage (km)" placeholder="e.g. 45000" keyboardType="number-pad" value={vehicle.mileage} onChangeText={(v) => setVehicle({ ...vehicle, mileage: v })} style={styles.half} />
            </View>
          </>
        )}

        {step.key === 'preInstall' && <Checklist rows={pre} onChange={setPre} defs={PRE_INSTALL} ticketId={ticket.id} />}
        {step.key === 'electrical' && <Checklist rows={elec} onChange={setElec} defs={ELECTRICAL} ticketId={ticket.id} />}
        {step.key === 'postInstall' && <Checklist rows={post} onChange={setPost} defs={POST_INSTALL} ticketId={ticket.id} />}

        {step.key === 'install' && (
          <>
            <Txt variant="muted">Record the installed device and network details.</Txt>
            <Field label="Device IMEI" placeholder="Scan / type the IMEI" keyboardType="numbers-and-punctuation"
              value={install.imei} onChangeText={(v) => setInstall({ ...install, imei: v })} required />
            <View style={styles.row2}>
              <Field label="SIM (MSISDN)" placeholder="07…" keyboardType="phone-pad" value={install.msisdn} onChangeText={(v) => setInstall({ ...install, msisdn: v })} style={styles.half} />
              <Field label="Signal" placeholder="e.g. -72 dBm" value={install.signal} onChangeText={(v) => setInstall({ ...install, signal: v })} style={styles.half} />
            </View>
            <Field label="Tracker phone / MSISDN on platform" placeholder="Number registered on the platform"
              value={install.trackerPhone} onChangeText={(v) => setInstall({ ...install, trackerPhone: v })} />

            <Divider spacer={spacing.sm} />
            <Txt variant="label">Activation</Txt>
            {!ticket.activationRequestedAt ? (
              <NeonButton label="Request activation (notify ISO)" icon="flash-outline" variant="subtle"
                onPress={async () => { try { await TechApi.notifyIso(ticket.id); toast.success('ISO notified for activation'); onDone(); } catch (e: any) { toast.error(e?.message || 'Failed'); } }} />
            ) : ticket.activationApprovedAt ? (
              <Txt style={{ color: colors.green }}>✓ Activation approved</Txt>
            ) : (
              <Txt variant="muted">Activation requested — awaiting ISO approval.</Txt>
            )}
            {isIso && ticket.activationRequestedAt && !ticket.activationApprovedAt && (
              <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
                <NeonButton label="Approve activation (ISO)" icon="shield-checkmark-outline" loading={saving}
                  onPress={async () => {
                    setSaving(true);
                    try {
                      // POST /activation-approve records the approval itself, but (per
                      // installation-tickets.ts) does NOT set engineer_signed_off_at —
                      // job-card.html's saveActivationAndAdvance() always follows it with
                      // this exact PATCH /status to actually satisfy the server's
                      // ENGINEER_SIGNOFF_REQUIRED completion gate. Without this follow-up
                      // call the job could never be completed despite activation showing
                      // as "approved". A prior interrupted attempt may have already
                      // approved it — tolerate the resulting 409 ALREADY_APPROVED and still
                      // run the follow-up, exactly as the web wizard does.
                      try {
                        await TechApi.activationApprove(ticket.id, { ignitionOk: true, locationOk: true });
                      } catch (approveErr: any) {
                        if (approveErr?.code !== 'ALREADY_APPROVED') throw approveErr;
                      }
                      await TechApi.updateStatus(ticket.id, {
                        activation: { ignitionOk: true, locationOk: true, confirmedAt: new Date().toISOString() },
                        engineerSignedOff: true,
                        stage: 7,
                      });
                      toast.success('Activation approved');
                      onDone();
                    } catch (e: any) {
                      toast.error(e?.message || 'Failed');
                    } finally {
                      setSaving(false);
                    }
                  }} />
              </View>
            )}
          </>
        )}

        {step.key === 'photos' && (
          <>
            <Txt variant="muted">Capture the required shots. Tap each to add a photo.</Txt>
            {PHOTO_SHOTS.map((s) => (
              <View key={s.id} style={styles.shot}>
                <EvidencePicker ticketId={ticket.id} label={s.label} value={photos[s.id] || []}
                  onChange={(next) => setPhotos((p) => ({ ...p, [s.id]: next }))} />
              </View>
            ))}
          </>
        )}

        {step.key === 'signoff' && (
          <>
            <Txt variant="muted">Review complete. Sign off to hand over to the ISO officer for confirmation.</Txt>

            {/* 1. Technician sign-off — requires a photo of the physically-signed job
                card, mirroring job-card.html's techSignOff() gate (jobCardPhotoUrl). */}
            {!ticket.technicianSignedOffAt ? (
              <View style={{ gap: spacing.sm }}>
                <Field label="Installation notes (optional)" placeholder="Any final notes, observations, or comments…"
                  value={signoffNotes} onChangeText={setSignoffNotes} multiline numberOfLines={3}
                  style={{ minHeight: 72, textAlignVertical: 'top' }} />
                <EvidencePicker ticketId={ticket.id} label="Physical job card photo (required)"
                  value={jobCardPhoto} onChange={setJobCardPhoto} />
                <NeonButton label="Technician sign-off" icon="create-outline"
                  disabled={jobCardPhoto.length === 0} loading={saving}
                  onPress={async () => {
                    setSaving(true);
                    try {
                      await TechApi.updateStatus(ticket.id, {
                        technicianSignedOff: true,
                        notes: signoffNotes.trim() || undefined,
                        jobCardPhotoUrl: jobCardPhoto[0]?.url,
                      });
                      toast.success('Signed off');
                      onDone();
                    } catch (e: any) {
                      toast.error(e?.message || 'Failed');
                    } finally {
                      setSaving(false);
                    }
                  }} />
              </View>
            ) : (
              <Txt style={{ color: colors.green }}>
                ✓ Technician signed off{ticket.engineerSignedOffAt ? '' : ' — awaiting ISO confirmation'}
              </Txt>
            )}

            {/* 2. Engineer / ISO sign-off — a separate, backend-enforced completion
                blocker (ENGINEER_SIGNOFF_REQUIRED) web satisfies with its own
                "Sign off as ISO" button. Gated to the same roles job-card.html's
                canEngineer check uses. */}
            {isIso && (
              <>
                <Divider spacer={spacing.sm} />
                {!ticket.engineerSignedOffAt ? (
                  <NeonButton label="Sign off as ISO" icon="shield-checkmark-outline" loading={saving}
                    onPress={async () => {
                      setSaving(true);
                      try {
                        await TechApi.updateStatus(ticket.id, { engineerSignedOff: true });
                        toast.success('ISO sign-off recorded');
                        onDone();
                      } catch (e: any) {
                        toast.error(e?.message || 'Failed');
                      } finally {
                        setSaving(false);
                      }
                    }} />
                ) : (
                  <Txt style={{ color: colors.green }}>✓ ISO signed off</Txt>
                )}
              </>
            )}

            {/* 3. Complete — sends the same {status:'Completed', stage:10} shape web
                does and surfaces the real blocker list on a 422 COMPLETION_BLOCKED,
                instead of a generic error toast. */}
            {ticket.technicianSignedOffAt && (
              <>
                <Divider spacer={spacing.sm} />
                <NeonButton label="Complete job" icon="checkmark-done-outline" loading={saving}
                  onPress={() => attemptComplete(false)} />
                {blockers.length > 0 && (
                  <View style={styles.blockerBox}>
                    <Txt variant="label" style={{ color: colors.red }}>Can't close yet:</Txt>
                    {blockers.map((b) => (
                      <Txt key={b.code} variant="faint" style={{ marginTop: 2 }}>• {b.message}</Txt>
                    ))}
                    {canForce && (
                      <NeonButton label="Force complete (override)" icon="warning-outline" variant="danger"
                        style={{ marginTop: spacing.sm }} onPress={() => setForceOpen(true)} />
                    )}
                  </View>
                )}
              </>
            )}
          </>
        )}
      </View>

      {/* Nav */}
      <View style={styles.nav}>
        <NeonButton label="Back" icon="chevron-back" variant="ghost" full={false}
          onPress={back} style={{ flex: 1, opacity: idx === 0 ? 0.4 : 1 }} />
        {step.key !== 'signoff' ? (
          <NeonButton label={saving ? 'Saving…' : 'Save & continue'} icon="chevron-forward" loading={saving}
            full={false} onPress={onNext} style={styles.navBtn} />
        ) : (
          <NeonButton label="Done" icon="checkmark" variant="ghost" full={false}
            onPress={onDone} style={styles.navBtn} />
        )}
      </View>

      {/* Force-complete reason sheet — only reachable when the server itself said
          this user's role may override (canForceComplete), mirroring job-card.html's
          window.prompt() reason capture before retrying with forceComplete:true. */}
      <Sheet visible={forceOpen} onClose={() => setForceOpen(false)} title="Force complete job">
        <Txt variant="muted" style={{ marginBottom: spacing.md }}>
          This overrides the unmet requirement(s) above. The override and your reason are logged against this job.
        </Txt>
        <Field label="Reason" placeholder="Why are you forcing this through?" value={forceReason} onChangeText={setForceReason}
          multiline numberOfLines={3} style={{ minHeight: 84, textAlignVertical: 'top' }} required />
        <NeonButton label="Force complete" variant="danger" loading={saving} style={{ marginTop: spacing.md }}
          onPress={() => {
            if (!forceReason.trim()) return toast.error('A reason is required');
            const reason = forceReason.trim();
            setForceOpen(false);
            setForceReason('');
            attemptComplete(true, reason);
          }} />
      </Sheet>
    </GlassCard>
  );
}

// ── Checklist renderer (tri-state Working / Issue / Faulty — matches job-card.html
// exactly so a checklist filled on one platform renders identically on the other) ──
function Checklist({ rows, onChange, defs, ticketId }: { rows: CheckRow[]; onChange: (r: CheckRow[]) => void; defs: CheckDef[]; ticketId: string }) {
  const setRow = (i: number, patch: Partial<CheckRow>) => onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const OPTIONS: { key: CheckState; label: string; color: string }[] = [
    { key: 'working', label: 'Working', color: colors.green },
    { key: 'issue',   label: 'Issue',   color: colors.amber },
    { key: 'faulty',  label: 'Faulty',  color: colors.red },
  ];
  return (
    <View style={{ gap: spacing.sm }}>
      {rows.map((r, i) => (
        <View key={r.id} style={styles.checkItem}>
          <Txt variant="body" weight="semibold">{r.label}</Txt>
          {defs[i]?.note ? <Txt variant="faint">{defs[i].note}</Txt> : null}
          <View style={styles.checkOpts}>
            {OPTIONS.map((o) => {
              const on = r.state === o.key;
              return (
                <Pressable key={o.key} onPress={() => setRow(i, { state: o.key })}
                  style={[styles.opt, on && { borderColor: o.color, backgroundColor: o.color + '22' }]}>
                  <Txt variant="faint" style={on ? { color: o.color, fontWeight: '700' } : undefined}>{o.label}</Txt>
                </Pressable>
              );
            })}
          </View>
          {r.state === 'issue' || r.state === 'faulty' ? (
            <View style={{ gap: spacing.sm, marginTop: spacing.xs }}>
              <Field label="" placeholder="Note the issue…" value={r.comment || ''} onChangeText={(v) => setRow(i, { comment: v })} />
              <EvidencePicker ticketId={ticketId} label="Photo of the issue"
                value={r.photos || []} onChange={(next) => setRow(i, { photos: next })} />
            </View>
          ) : (r.photos && r.photos.length ? (
            <Txt variant="faint" style={{ marginTop: 4 }}>{r.photos.length} photo(s) attached</Txt>
          ) : null)}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  headRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stepIcon: { width: 36, height: 36, borderRadius: radius.md, backgroundColor: colors.cyanDim, alignItems: 'center', justifyContent: 'center' },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.glassBorder, overflow: 'hidden', marginTop: spacing.md },
  fill: { height: 6, borderRadius: 3, backgroundColor: colors.cyan },
  dots: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.sm },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.glassBorder },
  dotActive: { backgroundColor: colors.cyan },
  dotDone: { backgroundColor: colors.green },
  row2: { flexDirection: 'row', gap: spacing.sm },
  half: { flex: 1 },
  checkItem: { padding: spacing.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.glassBorder, backgroundColor: colors.glassStrong, gap: 4 },
  checkOpts: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  opt: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.glassBorder },
  shot: { marginTop: spacing.sm },
  nav: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  navBtn: { flex: 1 },
  blockerBox: {
    marginTop: spacing.sm, padding: spacing.md, borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.red + '55', backgroundColor: colors.redDim,
  },
});

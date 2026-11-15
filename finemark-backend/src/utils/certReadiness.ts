// Certificate readiness evaluator, shared by the certificate dashboard and the
// certificate metrics endpoint. A partner bank's cert_bank_configs row declares which
// fields its certificate must carry (template + show_chassis / show_engine); a source
// row is "ready" only when it holds everything that bank's certificate needs.

export interface BankConfig {
  bank_name: string;
  full_name?: string | null;
  template: string;
  show_chassis: boolean;
  show_engine: boolean;
  is_default: boolean;
}

export interface ReadinessInput {
  registration?: any;
  chassis_number?: any;
  engine_number?: any;
  partner_bank?: string | null;
}

export interface Readiness {
  ready: boolean;
  missing: string[];
  bank: string;
  template: string;
}

const normBank = (s: string) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Build a readiness evaluator bound to the current cert_bank_configs. The returned
 * function is pure and cheap, safe to call per row.
 */
export function makeReadinessEvaluator(bankConfigs: any[]): (r: ReadinessInput) => Readiness {
  const cfgs: BankConfig[] = (bankConfigs as BankConfig[]) || [];
  const defaultCfg: BankConfig =
    cfgs.find((c) => c.is_default) ||
    ({ template: "unique", show_chassis: false, show_engine: false, bank_name: "Others", full_name: "Standard", is_default: true } as BankConfig);
  const privateCfg: BankConfig = cfgs.find((c) => String(c.bank_name).toUpperCase() === "PRIVATE") || defaultCfg;

  const resolveCfg = (partnerName?: string | null): BankConfig => {
    if (!partnerName) return privateCfg;
    const pn = normBank(partnerName);
    let best: BankConfig | null = null;
    for (const c of cfgs) {
      if (c.is_default) continue;
      const cn = normBank(c.bank_name);
      if (cn.length >= 3 && pn.includes(cn) && (!best || cn.length > normBank(best.bank_name).length)) best = c;
    }
    return best || defaultCfg;
  };

  return (r: ReadinessInput): Readiness => {
    const cfg = resolveCfg(r.partner_bank);
    const hasReg = !!String(r.registration || "").trim();
    const hasChassis = !!String(r.chassis_number || "").trim();
    const hasEngine = !!String(r.engine_number || "").trim();
    const missing: string[] = [];
    if (cfg.template === "unique") {
      // The Unique Tracking certificate identifies the vehicle solely by its plate.
      if (!hasReg) missing.push("Registration (number plate)");
    } else {
      if (!hasReg && !hasChassis) missing.push("Vehicle Reg / Chassis");
      if (cfg.show_chassis && !hasChassis) missing.push("Chassis No.");
      if (cfg.show_engine && !hasEngine) missing.push("Engine No.");
    }
    return { ready: missing.length === 0, missing, bank: cfg.full_name || cfg.bank_name || "Standard", template: cfg.template };
  };
}

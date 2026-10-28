import React, { useEffect, useState } from "react";
import type { CrystalStructure } from "../structures/types";
import type { XrdResult } from "../synthesis/types";
import { synthesisRequest, xrdPayload } from "../synthesis/client";
import XrdPlot from "./XrdPlot";
import "./synthesis.css";

export default function InlineXrd({ structure, active, onOpen }: { structure: CrystalStructure; active: boolean; onOpen?(): void }) {
  const [result, setResult] = useState<XrdResult | null>(null), [error, setError] = useState("");
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); setResult(null); setError("");
    void synthesisRequest<XrdResult>("xrd", xrdPayload(structure), controller.signal).then(setResult).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [structure, active]);
  return <section className="inline-xrd"><div className="inline-xrd-heading"><div><b>理论模拟 XRD</b><small>Cu Kα · 10–80° · 当前晶胞</small></div>{onOpen && <button type="button" onClick={onOpen}>实验比对与合成预审 ↗</button>}</div>
    {result ? <XrdPlot pattern={result.pattern} compact /> : <p className="inline-xrd-status">{error || "正在计算衍射峰…"}</p>}
  </section>;
}

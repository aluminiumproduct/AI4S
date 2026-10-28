import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Material } from "../../types";
import type { ModelConfig } from "../models/config";
import { buildDistillationSnapshot, compositionGroup } from "./features";
import { DistillationWorkerClient } from "./DistillationWorkerClient";
import { freezePartitions, splitCompositionGroups } from "./partitions";
import { DEFAULT_DISTILLATION_OPTIONS, type DistillationResult, type DistillationTarget, type PartitionAssignments, type Supplements } from "./types";

export function useDistillation(input: { pool: Material[]; runId: number; iteration: number; isRealData: boolean;
  modelConfig: ModelConfig; isRunning: boolean; loading: boolean }) {
  const [options, setOptions] = useState({ ...DEFAULT_DISTILLATION_OPTIONS });
  const [target, setTarget] = useState<DistillationTarget>("observed");
  const [supplements, setSupplements] = useState<Supplements>({});
  const [automatic, setAutomatic] = useState(true);
  const [result, setResult] = useState<DistillationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const client = useRef<DistillationWorkerClient | null>(null);
  const serial = useRef(0), lastRequested = useRef(0);
  const partitions = useRef<PartitionAssignments>({});
  const partitionIdentity = JSON.stringify([input.runId, input.isRealData, options.seed]);
  const identity = JSON.stringify([input.runId, input.isRealData, input.modelConfig, options, target, supplements]);
  const identityRef = useRef(identity); identityRef.current = identity;
  const sampled = useMemo(() => input.pool.filter(material => material.isSampled), [input.pool]);
  const materialIds = useMemo(() => new Set(input.pool.map(material => material.id)), [input.pool]);
  const groups = useMemo(() => new Set(sampled.map(material => compositionGroup(material.composition))).size, [sampled]);

  useEffect(() => { partitions.current = {}; }, [partitionIdentity]);
  useEffect(() => {
    serial.current++; client.current?.cancel(); lastRequested.current = 0;
    setBusy(false); setResult(null); setError(null); setCancelled(false);
    return () => { serial.current++; client.current?.dispose(); };
  }, [identity]);

  const run = useCallback(async () => {
    if (busy || input.loading || sampled.length < options.minSamples || groups < 8) return;
    const request = ++serial.current, capturedIdentity = identity;
    lastRequested.current = sampled.length;
    setBusy(true); setError(null); setCancelled(false);
    try {
      partitions.current = freezePartitions(splitCompositionGroups(sampled.map(material => ({ group: compositionGroup(material.composition) })), options.seed, partitions.current));
      const snapshot = buildDistillationSnapshot(input.pool, { runId: input.runId, iteration: input.iteration,
        target, objective: input.isRealData ? "band-gap" : "synthetic-score", modelConfig: input.modelConfig, supplements,
        partitions: partitions.current, searchOptions: options });
      if (!client.current) client.current = new DistillationWorkerClient();
      const response = await client.current.run(snapshot, options);
      if (request === serial.current && identityRef.current === capturedIdentity) setResult(response);
    } catch (error) {
      if (request !== serial.current || identityRef.current !== capturedIdentity) return;
      if (!(error instanceof Error && error.name === "AbortError")) setError(error instanceof Error ? error.message : "公式搜索失败");
    } finally {
      if (request === serial.current && identityRef.current === capturedIdentity) setBusy(false);
    }
  }, [busy, identity, input.pool, input.loading, input.runId, input.iteration, input.isRealData, input.modelConfig, sampled.length, groups, options, target, supplements]);

  useEffect(() => {
    if (!automatic || busy || input.loading || sampled.length < options.minSamples || groups < 8) return;
    if (lastRequested.current === 0 || sampled.length >= lastRequested.current + 10
      || !input.isRunning && sampled.length > lastRequested.current) void run();
  }, [automatic, busy, input.loading, input.isRunning, sampled.length, groups, options.minSamples, run]);

  const cancel = () => {
    serial.current++; client.current?.cancel(); setBusy(false); setAutomatic(false); setCancelled(true);
  };
  return { options, setOptions, target, setTarget, supplements, setSupplements, automatic, setAutomatic,
    result, busy, error, cancelled, run, cancel, sampleCount: sampled.length, groupCount: groups,
    materialIds, ready: sampled.length >= options.minSamples && groups >= 8 && !input.loading };
}
export type DistillationController = ReturnType<typeof useDistillation>;

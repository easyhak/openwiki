import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import {
  inspectClaimsMigration,
  runClaimsMigration,
  type ClaimsMigrationEvent,
  type ClaimsMigrationPageResult,
  type ClaimsMigrationResult,
  type ClaimsMigrationStatus,
} from "../migrations/claims.js";
import { getErrorMessage } from "../platform/diagnostics.js";
import { Panel } from "./components/primitives.js";
import { getSpinnerFrame } from "./format.js";

type MigrationViewState =
  | { step: "loading" }
  | { step: "select"; status: ClaimsMigrationStatus; selected: boolean }
  | { step: "confirm"; status: ClaimsMigrationStatus }
  | {
      step: "running";
      status: ClaimsMigrationStatus;
      currentPage: string | null;
      activity: string;
      completed: ClaimsMigrationPageResult[];
    }
  | {
      step: "complete";
      status: ClaimsMigrationStatus;
      result: ClaimsMigrationResult;
    }
  | { step: "error"; message: string };

export interface MigrateAppProps {
  cwd?: string;
  inspect?: typeof inspectClaimsMigration;
  run?: typeof runClaimsMigration;
}

/**
 * Interactive migration center. Claims is intentionally the only exposed
 * migration until another capability requires an explicit upgrade.
 */
export function MigrateApp({
  cwd = process.cwd(),
  inspect = inspectClaimsMigration,
  run = runClaimsMigration,
}: MigrateAppProps) {
  const app = useApp();
  const [state, setState] = useState<MigrationViewState>({ step: "loading" });

  useEffect(() => {
    let active = true;
    void inspect(cwd)
      .then((status) => {
        if (active) {
          setState({
            step: "select",
            status,
            selected: status.pendingPages.length > 0,
          });
        }
      })
      .catch((error) => {
        if (active) {
          process.exitCode = 1;
          setState({ step: "error", message: getErrorMessage(error) });
        }
      });
    return () => {
      active = false;
    };
  }, [cwd, inspect]);

  useInput((input, key) => {
    if (state.step === "loading" || state.step === "running") return;

    if (state.step === "error" || state.step === "complete") {
      if (key.return || key.escape) app.exit();
      return;
    }

    if (key.escape) {
      app.exit();
      return;
    }

    if (state.step === "select") {
      if (input === " ") {
        if (state.status.pendingPages.length > 0) {
          setState({ ...state, selected: !state.selected });
        }
        return;
      }
      if (key.return && state.selected) {
        setState({ step: "confirm", status: state.status });
      } else if (key.return && state.status.pendingPages.length === 0) {
        app.exit();
      }
      return;
    }

    if (state.step === "confirm") {
      if (input.toLowerCase() === "y") {
        startMigration(state.status);
      } else if (input.toLowerCase() === "n" || key.return) {
        app.exit();
      }
    }
  });

  function startMigration(status: ClaimsMigrationStatus): void {
    setState({
      step: "running",
      status,
      currentPage: null,
      activity: "Preparing migration",
      completed: [],
    });

    void run(cwd, {
      onEvent: updateProgress,
    })
      .then((result) => {
        if (result.failed) process.exitCode = 1;
        setState({ step: "complete", status, result });
      })
      .catch((error) => {
        process.exitCode = 1;
        setState({ step: "error", message: getErrorMessage(error) });
      });
  }

  function updateProgress(event: ClaimsMigrationEvent): void {
    setState((current) => {
      if (current.step !== "running") return current;
      if (event.type === "page_start") {
        return {
          ...current,
          currentPage: event.page,
          activity: "Inspecting page",
        };
      }
      if (event.type === "activity") {
        return { ...current, activity: event.message };
      }
      if (event.type === "page_complete") {
        return {
          ...current,
          currentPage: null,
          activity: "Page persisted",
          completed: [...current.completed, event],
        };
      }
      return {
        ...current,
        currentPage: event.page,
        activity: getErrorMessage(event.error),
      };
    });
  }

  return <MigrationView state={state} />;
}

function MigrationView({ state }: { state: MigrationViewState }) {
  if (state.step === "loading") {
    return <Text color="gray">Inspecting OpenWiki migrations…</Text>;
  }

  if (state.step === "error") {
    return (
      <Panel title="Migration failed">
        <Text color="red">{state.message}</Text>
        <Text color="gray">Press Enter to exit.</Text>
      </Panel>
    );
  }

  if (state.step === "select") {
    const pending = state.status.pendingPages.length;
    return (
      <Panel title="OpenWiki migrations">
        <Text>Select migrations to run:</Text>
        <Box marginTop={1}>
          <Text color={pending === 0 ? "gray" : "cyan"}>
            {state.selected ? "[x]" : "[ ]"} Claims
          </Text>
          <Text color="gray">
            {`  ${state.status.completedPages.length} / ${state.status.totalPages} pages complete`}
          </Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          {pending === 0 ? (
            <>
              <Text color="green">No Claims migration work is pending.</Text>
              <Text color="gray">Press Enter to exit.</Text>
            </>
          ) : (
            <Text color="gray">Space select · Enter continue · Esc cancel</Text>
          )}
        </Box>
      </Panel>
    );
  }

  if (state.step === "confirm") {
    return (
      <Panel title="Claims migration">
        <Text>
          This migration will analyze {state.status.pendingPages.length} wiki
          page
          {state.status.pendingPages.length === 1 ? "" : "s"} against current
          repository source and generate evidence-backed Claims.
        </Text>
        <Text>
          Accurate Markdown is preserved. Unsupported or stale prose may be
          updated. This uses your configured model, may take significant time,
          and saves progress page by page.
        </Text>
        <Box marginTop={1}>
          <Text bold>Continue? [y/N]</Text>
        </Box>
      </Panel>
    );
  }

  if (state.step === "running") {
    return <RunningMigrationView state={state} />;
  }

  const updated = state.result.completed.filter(
    (result) => result.pageUpdated,
  ).length;
  const claims = state.result.completed.reduce(
    (total, result) => total + result.claimCount,
    0,
  );
  return (
    <Panel
      title={
        state.result.failed
          ? "Claims migration stopped with an error"
          : "Claims migration complete"
      }
    >
      <Text color="green">
        {state.result.completed.length} page
        {state.result.completed.length === 1 ? "" : "s"} migrated
      </Text>
      <Text>
        {claims} claim{claims === 1 ? "" : "s"} persisted
      </Text>
      <Text>
        {updated} Markdown page{updated === 1 ? "" : "s"} updated
      </Text>
      {state.result.failed ? (
        <>
          <Text color="red">
            {displayPage(state.result.failed.page)}:{" "}
            {state.result.failed.error.message}
          </Text>
          <Text color="gray">
            {state.result.remainingPages.length} pages remain. Re-run `openwiki
            migrate` to resume.
          </Text>
        </>
      ) : null}
      <Text color="gray">Press Enter to exit.</Text>
    </Panel>
  );
}

function RunningMigrationView({
  state,
}: {
  state: Extract<MigrationViewState, { step: "running" }>;
}) {
  const [animationFrame, setAnimationFrame] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    setAnimationFrame(0);
    setElapsedSeconds(0);
    if (!state.currentPage) return;

    const startedAt = Date.now();
    const interval = setInterval(() => {
      setAnimationFrame((frame) => frame + 1);
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 140);

    return () => {
      clearInterval(interval);
    };
  }, [state.currentPage]);

  const migrated = state.completed.length;
  const total = state.status.pendingPages.length;
  const completedPages = new Set(state.completed.map(({ page }) => page));
  const pendingPages = state.status.pendingPages.filter(
    (page) => !completedPages.has(page),
  );

  return (
    <Panel title={`Migrating Claims ${migrated} / ${total}`}>
      {state.completed.slice(-5).map((result) => (
        <Text key={result.page} color="green">
          ✓ {displayPage(result.page)} · {result.claimCount} claims persisted
          {result.pageUpdated ? " · page updated" : ""}
        </Text>
      ))}
      <Box flexDirection="column" marginTop={migrated > 0 ? 1 : 0}>
        <Text color="gray">Pending ({pendingPages.length})</Text>
        {pendingPages.map((page) => {
          const isCurrent = page === state.currentPage;
          return (
            <Text key={page} color={isCurrent ? "cyan" : "gray"}>
              {isCurrent ? `${getSpinnerFrame(animationFrame)} ` : "· "}
              {displayPage(page)}
              {isCurrent
                ? ` · ${formatElapsed(elapsedSeconds)} elapsed · last activity: ${state.activity}`
                : ""}
            </Text>
          );
        })}
      </Box>
    </Panel>
  );
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function displayPage(page: string): string {
  return page.replace(/^\/openwiki\//u, "");
}

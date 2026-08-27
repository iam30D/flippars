"""Strict, offline Binance Spot BTCUSDT training and evaluation pipeline.

This package deliberately produces only immutable DRAFT candidates.  It uses
public Binance Data Vision trade archives, never credentials or trading APIs.
Raw data, prepared datasets, manifests, evaluations, and artifacts belong in a
separate training workspace outside the Git repository.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import heapq
import importlib.util
import io
import json
import math
import os
import platform
import re
import shutil
import stat
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import asdict, dataclass, field
from decimal import Decimal
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Iterable, Iterator, Sequence

import numpy as np


BINANCE_DATA_VISION = "https://data.binance.vision/"
SUPPORTED_SYMBOL = "BTCUSDT"
SIGNAL_TYPES = (
    "FIVE_MINUTE_REVERSAL",
    "FIFTEEN_MINUTE_REVERSAL",
    "FIVE_MINUTE_EARLY_DIRECTION",
)
SIGNAL_DURATION_SECONDS = {
    "FIVE_MINUTE_REVERSAL": 300,
    "FIFTEEN_MINUTE_REVERSAL": 900,
    "FIVE_MINUTE_EARLY_DIRECTION": 300,
}
CLASS_ORDER = ("ABOVE_OPEN", "BELOW_OPEN", "AT_OPEN")
ARTIFACT_SCHEMA_VERSION = "flippars.multinomial-candidate/4"
DATASET_SCHEMA_VERSION = "flippars.training-dataset/3"
DATASET_MANIFEST_SCHEMA_VERSION = "flippars.dataset-manifest/3"
DATASET_MANIFEST_SUMMARY_SCHEMA_VERSION = "flippars.dataset-manifest-summary/4"
ARCHIVE_PREPARATION_PLAN_SCHEMA_VERSION = "flippars.archive-preparation-plan/1"
ARCHIVE_PREPARATION_CHECKPOINT_SCHEMA_VERSION = "flippars.archive-preparation-checkpoint/2"
FEATURE_SCHEMA_VERSION = "binance-spot-signal-features/1"
LABEL_POLICY_VERSION = "binance-spot-trade-close-relation/1"
DECISION_POLICY_VERSION = "flippars-signal-candidate-sampling/1"
CROSS_VENUE_GUARD_POLICY_VERSION = "btc-usd-cross-venue-health/1"
PRE_EVALUATION_POLICY_SCHEMA_VERSION = "flippars.pre-evaluation-policy/2"
PRE_EVALUATION_POLICY_CANONICALIZATION = (
    "SORTED_KEYS_ASCII_JSON_STRING_PREIMAGES_V1"
)
DEFAULT_DEADBAND_BPS = 5.0
DEFAULT_DECISION_CADENCE_SECONDS = 15
DEFAULT_MINIMUM_LEAD_TIME_SECONDS = 15
SIGNAL_MINIMUM_LEAD_TIME_SECONDS = {
    "FIVE_MINUTE_REVERSAL": 15,
    "FIFTEEN_MINUTE_REVERSAL": 30,
    "FIVE_MINUTE_EARLY_DIRECTION": 15,
}
DEFAULT_VALIDITY_DAYS = 120
PARTITION_ROW_BUDGETS = {"train": 60_000, "calibration": 30_000, "holdout": 60_000}
ANOMALY_RISK_CEILING = 0.65
FEATURE_NAMES = (
    "previous_return_bps",
    "previous_range_bps",
    "previous_volume_log1p",
    "previous_trade_count_log1p",
    "previous_buy_ratio",
    "previous_close_location",
    "current_return_from_open_bps",
    "current_range_bps",
    "current_volume_log1p",
    "current_trade_count_log1p",
    "current_buy_ratio",
    "current_close_location",
    "elapsed_ratio",
    "remaining_ratio",
    "return_3_candle_bps",
    "return_12_candle_bps",
    "realized_volatility_12",
    "mean_range_12_bps",
    "previous_volume_relative_12",
    "previous_trade_count_relative_12",
    "current_volume_rate_log1p",
    "current_trade_rate_log1p",
    "current_volume_rate_relative_12",
    "current_trade_rate_relative_12",
)
NORMALIZED_HEADER = (
    "event_time_utc",
    "trade_id",
    "price",
    "quantity",
    "quote_quantity",
    "is_buyer_maker",
    "source_file",
)
ARCHIVE_PATTERN = re.compile(
    r"(?P<symbol>[A-Z0-9]+)-trades-(?P<day>\d{4}-\d{2}-\d{2})\.zip$"
)
CHECKSUM_PATTERN = re.compile(r"^(?P<digest>[a-fA-F0-9]{64})\s+\*?(?P<name>[^\s]+)$")
VERSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$")
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$")
MAX_CHECKSUM_BYTES = 1_024
MAX_ARCHIVE_MEMBER_BYTES = 16 * 1_024 * 1_024 * 1_024
CHECKPOINT_SAFE_TEMPORARY_TOKEN = r"[A-Za-z0-9_-]{8}"
ARCHIVE_CHECKPOINT_DIRECTORY_PATTERN = re.compile(r"^[0-9]{8}$")
ARCHIVE_CHECKPOINT_TEMPORARY_PATTERN = re.compile(
    rf"^\.[0-9]{{8}}\.{CHECKPOINT_SAFE_TEMPORARY_TOKEN}\.part$"
)
ARCHIVE_PLAN_TEMPORARY_PATTERN = re.compile(
    rf"^\.plan\.json\.{CHECKPOINT_SAFE_TEMPORARY_TOKEN}\.part$"
)


@dataclass(frozen=True)
class Trade:
    event_time: datetime
    trade_id: str
    price: float
    quantity: float
    quote_quantity: float
    is_buyer_maker: bool
    source_file: str


@dataclass
class Candle:
    start: datetime
    end: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float
    buy_volume: float
    sell_volume: float
    trade_count: int


@dataclass
class ArchiveReport:
    archive: str
    symbol: str
    day: str
    archive_sha256: str
    expected_sha256: str
    member: str
    archive_bytes: int = 0
    checksum_name: str = ""
    checksum_bytes: int = 0
    checksum_sha256: str = ""
    accepted_trade_count: int = 0
    rejected_trade_count: int = 0
    duplicate_trade_count: int = 0
    out_of_order_trade_count: int = 0
    first_event_at: str | None = None
    last_event_at: str | None = None
    normalized_file: str = ""
    normalized_sha256: str = ""
    first_trade_id: str | None = None
    last_trade_id: str | None = None
    missing_trade_id_count: int = 0
    missing_trade_id_ranges: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class DatasetOptions:
    signal_type: str
    deadband_bps: float
    timeframe_minutes: int
    decision_cadence_seconds: int
    minimum_lead_time_seconds: int


def main() -> None:
    args = build_parser().parse_args()
    if args.command == "collect":
        files = collect_daily_archives(
            symbol=args.symbol,
            start=date.fromisoformat(args.start),
            end=date.fromisoformat(args.end),
            raw_root=Path(args.raw_root),
            base_url=args.base_url,
            overwrite=args.overwrite,
            max_files=args.max_files,
        )
        print(json.dumps({"archives": [str(path.resolve()) for path in files]}))
        return
    if args.command == "prepare":
        result = prepare_dataset(
            normalized_root=Path(args.normalized_root),
            output=Path(args.output),
            manifest_output=Path(args.manifest_output),
            signal_type=args.signal_type,
            deadband_bps=args.deadband_bps,
            timeframe_minutes=args.timeframe_minutes,
            decision_cadence_seconds=args.decision_cadence_seconds,
            minimum_lead_time_seconds=args.minimum_lead_time_seconds,
        )
        print(json.dumps(result, indent=2))
        return
    if args.command == "prepare-archives":
        archives = select_offline_archives(
            Path(args.archive_root),
            date.fromisoformat(args.start),
            date.fromisoformat(args.end),
        )
        result = prepare_archives(
            archives=archives,
            output=Path(args.output),
            manifest_output=Path(args.manifest_output),
            signal_type=args.signal_type,
            deadband_bps=args.deadband_bps,
            timeframe_minutes=args.timeframe_minutes,
            decision_cadence_seconds=args.decision_cadence_seconds,
            minimum_lead_time_seconds=args.minimum_lead_time_seconds,
            acquisition_manifest_path=(
                Path(args.acquisition_manifest) if args.acquisition_manifest else None
            ),
        )
        print(json.dumps(result, indent=2))
        return
    if args.command == "preflight-archive-resume":
        archives = select_offline_archives(
            Path(args.archive_root),
            date.fromisoformat(args.start),
            date.fromisoformat(args.end),
        )
        result = preflight_archive_resume(
            archives=archives,
            output=Path(args.output),
            manifest_output=Path(args.manifest_output),
            signal_type=args.signal_type,
            deadband_bps=args.deadband_bps,
            timeframe_minutes=args.timeframe_minutes,
            decision_cadence_seconds=args.decision_cadence_seconds,
            minimum_lead_time_seconds=args.minimum_lead_time_seconds,
            acquisition_manifest_path=(
                Path(args.acquisition_manifest) if args.acquisition_manifest else None
            ),
        )
        print(json.dumps(result, separators=(",", ":")))
        return
    if args.command == "train":
        result = train_draft(
            input_path=Path(args.input),
            manifest_path=Path(args.manifest),
            output_path=Path(args.output),
            evaluation_path=Path(args.evaluation_output),
            signal_type=args.signal_type,
            version=args.version,
            deadband_bps=args.deadband_bps,
            confidence_threshold=args.confidence_threshold,
            validity_days=args.validity_days,
        )
        print(json.dumps(result, indent=2))
        return
    if args.command == "all":
        result = run_all(args)
        print(json.dumps(result, indent=2))
        return
    if args.command == "smoke":
        print(json.dumps(run_smoke(Path(args.work_root)), indent=2))
        return
    raise AssertionError("unreachable command")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    collect = commands.add_parser("collect", help="Download and verify Binance daily trade archives.")
    _add_collection_arguments(collect)

    prepare = commands.add_parser("prepare", help="Build point-in-time, signal-specific training rows.")
    prepare.add_argument("--normalized-root", required=True)
    prepare.add_argument("--output", required=True)
    prepare.add_argument("--manifest-output", required=True)
    _add_dataset_arguments(prepare)

    prepare_archives_command = commands.add_parser(
        "prepare-archives",
        help="Offline-only streamed preparation from an exact verified archive snapshot.",
    )
    prepare_archives_command.add_argument("--archive-root", required=True)
    prepare_archives_command.add_argument("--start", required=True)
    prepare_archives_command.add_argument("--end", required=True)
    prepare_archives_command.add_argument("--output", required=True)
    prepare_archives_command.add_argument("--manifest-output", required=True)
    prepare_archives_command.add_argument("--acquisition-manifest")
    _add_dataset_arguments(prepare_archives_command)

    preflight_archive_resume_command = commands.add_parser(
        "preflight-archive-resume",
        help="Read-only full admission check for one durable archive-preparation resume.",
    )
    preflight_archive_resume_command.add_argument("--archive-root", required=True)
    preflight_archive_resume_command.add_argument("--start", required=True)
    preflight_archive_resume_command.add_argument("--end", required=True)
    preflight_archive_resume_command.add_argument("--output", required=True)
    preflight_archive_resume_command.add_argument("--manifest-output", required=True)
    preflight_archive_resume_command.add_argument("--acquisition-manifest")
    _add_dataset_arguments(preflight_archive_resume_command)

    train = commands.add_parser("train", help="Fit, calibrate, replay, and write a v3 DRAFT artifact.")
    train.add_argument("--input", required=True)
    train.add_argument("--manifest", required=True)
    train.add_argument("--output", required=True)
    train.add_argument("--evaluation-output", required=True)
    train.add_argument("--signal-type", choices=SIGNAL_TYPES, required=True)
    train.add_argument("--version", required=True)
    train.add_argument("--deadband-bps", type=float, default=DEFAULT_DEADBAND_BPS)
    train.add_argument("--confidence-threshold", type=float, default=0.75)
    train.add_argument("--validity-days", type=int, default=DEFAULT_VALIDITY_DAYS)

    all_command = commands.add_parser("all", help="Collect, verify, normalize, prepare, train, and evaluate.")
    _add_collection_arguments(all_command)
    all_command.add_argument("--prepared-output", required=True)
    all_command.add_argument("--manifest-output", required=True)
    all_command.add_argument("--artifact-output", required=True)
    all_command.add_argument("--evaluation-output", required=True)
    _add_dataset_arguments(all_command)
    all_command.add_argument("--version", required=True)
    all_command.add_argument("--confidence-threshold", type=float, default=0.75)
    all_command.add_argument("--validity-days", type=int, default=DEFAULT_VALIDITY_DAYS)

    smoke = commands.add_parser("smoke", help="Run a deterministic synthetic end-to-end smoke check.")
    smoke.add_argument("--work-root", required=True)
    return parser


def _add_collection_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--symbol", default=SUPPORTED_SYMBOL)
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--raw-root", required=True)
    parser.add_argument("--base-url", default=BINANCE_DATA_VISION)
    parser.add_argument("--max-files", type=int, default=31)
    parser.add_argument("--overwrite", action="store_true")


def _add_dataset_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--signal-type", choices=SIGNAL_TYPES, required=True)
    parser.add_argument("--deadband-bps", type=float, default=DEFAULT_DEADBAND_BPS)
    parser.add_argument("--timeframe-minutes", type=int, choices=(5, 15))
    parser.add_argument(
        "--decision-cadence-seconds", type=int, default=DEFAULT_DECISION_CADENCE_SECONDS
    )
    parser.add_argument(
        "--minimum-lead-time-seconds", type=int
    )


def run_all(args: argparse.Namespace) -> dict[str, object]:
    raw_root = Path(args.raw_root)
    archives = collect_daily_archives(
        symbol=args.symbol,
        start=date.fromisoformat(args.start),
        end=date.fromisoformat(args.end),
        raw_root=raw_root,
        base_url=args.base_url,
        overwrite=args.overwrite,
        max_files=args.max_files,
    )
    prepared = prepare_archives(
        archives=archives,
        output=Path(args.prepared_output),
        manifest_output=Path(args.manifest_output),
        signal_type=args.signal_type,
        deadband_bps=args.deadband_bps,
        timeframe_minutes=args.timeframe_minutes,
        decision_cadence_seconds=args.decision_cadence_seconds,
        minimum_lead_time_seconds=args.minimum_lead_time_seconds,
    )
    trained = train_draft(
        input_path=Path(args.prepared_output),
        manifest_path=Path(args.manifest_output),
        output_path=Path(args.artifact_output),
        evaluation_path=Path(args.evaluation_output),
        signal_type=args.signal_type,
        version=args.version,
        deadband_bps=args.deadband_bps,
        confidence_threshold=args.confidence_threshold,
        validity_days=args.validity_days,
    )
    return {
        "archives": [str(path.resolve()) for path in archives],
        "prepared": prepared,
        "trained": trained,
    }


def prepare_archives(
    *,
    archives: Sequence[Path],
    output: Path,
    manifest_output: Path,
    signal_type: str,
    deadband_bps: float,
    timeframe_minutes: int | None,
    decision_cadence_seconds: int,
    minimum_lead_time_seconds: int | None,
    acquisition_manifest_path: Path | None = None,
) -> dict[str, object]:
    duration_seconds = SIGNAL_DURATION_SECONDS.get(signal_type)
    expected_minutes = (duration_seconds or 0) // 60
    if timeframe_minutes is None:
        timeframe_minutes = expected_minutes
    if minimum_lead_time_seconds is None:
        minimum_lead_time_seconds = SIGNAL_MINIMUM_LEAD_TIME_SECONDS[signal_type]
    options = DatasetOptions(
        signal_type=signal_type,
        deadband_bps=deadband_bps,
        timeframe_minutes=timeframe_minutes,
        decision_cadence_seconds=decision_cadence_seconds,
        minimum_lead_time_seconds=minimum_lead_time_seconds,
    )
    validate_dataset_options(options)
    ordered_archives = sorted(archives)
    if not ordered_archives:
        raise ValueError("At least one verified archive is required")
    archive_days = [
        date.fromisoformat(ARCHIVE_PATTERN.fullmatch(path.name).group("day"))
        if ARCHIVE_PATTERN.fullmatch(path.name)
        else None
        for path in ordered_archives
    ]
    if any(day is None for day in archive_days):
        raise ValueError("Every source archive must use the governed BTCUSDT daily filename")
    typed_archive_days = [day for day in archive_days if day is not None]
    if any(
        current != previous + timedelta(days=1)
        for previous, current in zip(typed_archive_days, typed_archive_days[1:])
    ):
        raise ValueError("Source archive dates must form one contiguous UTC range")
    return write_resumable_archive_dataset(
        archives=ordered_archives,
        output=output,
        manifest_output=manifest_output,
        options=options,
        acquisition_manifest_path=acquisition_manifest_path,
    )


def preflight_archive_resume(
    *,
    archives: Sequence[Path],
    output: Path,
    manifest_output: Path,
    signal_type: str,
    deadband_bps: float,
    timeframe_minutes: int | None,
    decision_cadence_seconds: int,
    minimum_lead_time_seconds: int | None,
    acquisition_manifest_path: Path | None = None,
) -> dict[str, object]:
    """Validate one durable resume state without changing any file."""
    duration_seconds = SIGNAL_DURATION_SECONDS.get(signal_type)
    expected_minutes = (duration_seconds or 0) // 60
    if timeframe_minutes is None:
        timeframe_minutes = expected_minutes
    if minimum_lead_time_seconds is None:
        minimum_lead_time_seconds = SIGNAL_MINIMUM_LEAD_TIME_SECONDS[signal_type]
    options = DatasetOptions(
        signal_type=signal_type,
        deadband_bps=deadband_bps,
        timeframe_minutes=timeframe_minutes,
        decision_cadence_seconds=decision_cadence_seconds,
        minimum_lead_time_seconds=minimum_lead_time_seconds,
    )
    validate_dataset_options(options)
    ordered_archives = sorted(archives)
    if not ordered_archives:
        raise ValueError("At least one verified archive is required")
    archive_days = [
        date.fromisoformat(ARCHIVE_PATTERN.fullmatch(path.name).group("day"))
        if ARCHIVE_PATTERN.fullmatch(path.name)
        else None
        for path in ordered_archives
    ]
    if any(day is None for day in archive_days):
        raise ValueError("Every source archive must use the governed BTCUSDT daily filename")
    typed_archive_days = [day for day in archive_days if day is not None]
    if any(
        current != previous + timedelta(days=1)
        for previous, current in zip(typed_archive_days, typed_archive_days[1:])
    ):
        raise ValueError("Source archive dates must form one contiguous UTC range")

    checkpoint_root = archive_checkpoint_root(output)
    if checkpoint_root.is_symlink() or not checkpoint_root.is_dir():
        raise ValueError("Resume preflight requires a real archive checkpoint root")
    checkpoint_root_names = {entry.name for entry in checkpoint_root.iterdir()}
    if checkpoint_root_names != {"archives", "plan.json"}:
        raise ValueError(
            "Resume preflight checkpoint root must contain only archives and plan.json"
        )
    archives_root = checkpoint_root / "archives"
    plan_path = checkpoint_root / "plan.json"
    if archives_root.is_symlink() or not archives_root.is_dir():
        raise ValueError("Resume preflight requires a real checkpoint archives directory")
    if plan_path.is_symlink() or not plan_path.is_file():
        raise ValueError("Resume preflight requires a regular durable plan")

    expected_plan = build_archive_preparation_plan(
        archives=ordered_archives,
        output=output,
        manifest_output=manifest_output,
        options=options,
        acquisition_manifest_path=acquisition_manifest_path,
    )
    actual_plan, _ = read_json_object_and_sha256(plan_path)
    if actual_plan != expected_plan:
        raise ValueError("Resume preflight plan does not match current immutable inputs")
    checkpoints = load_archive_checkpoints(
        archives_root=archives_root,
        expected_plan=expected_plan,
        discard_abandoned_temporaries=False,
    )
    if not checkpoints:
        raise ValueError("Resume preflight requires at least one durable daily checkpoint")

    output_exists = output.exists()
    manifest_exists = manifest_output.exists()
    if manifest_exists and not output_exists:
        raise ValueError("Resume preflight rejects a manifest without its prepared dataset")
    if output_exists and (output.is_symlink() or not output.is_file()):
        raise ValueError("Resume preflight prepared output is not a regular file")
    if manifest_exists and (
        manifest_output.is_symlink() or not manifest_output.is_file()
    ):
        raise ValueError("Resume preflight dataset manifest is not a regular file")
    checkpoints_complete = len(checkpoints) == len(ordered_archives)
    if output_exists and not checkpoints_complete:
        raise ValueError("Published resume output requires every archive checkpoint")
    remove_abandoned_finalization_temporaries(
        (output, manifest_output),
        checkpoint_root_was_present=True,
        checkpoints_complete=checkpoints_complete,
        remove=False,
    )

    last_record, expected_report, _ = checkpoints[-1]
    previous_state = last_record["previousState"]
    if not isinstance(previous_state, dict):
        raise ValueError("Resume preflight checkpoint previous state is invalid")
    before_id = checkpoint_optional_string(
        previous_state["lastTradeId"], "lastTradeId"
    )
    before_event = checkpoint_optional_string(
        previous_state["lastEventAt"], "lastEventAt"
    )
    rebuilt_report, _, _, rebuilt_gaps = prepare_archive_batch(
        archive_path=ordered_archives[len(checkpoints) - 1],
        options=options,
        history_tail=[],
        previous_day_last_id=before_id,
        previous_day_last_event=parse_timestamp(before_event) if before_event else None,
    )
    if asdict(rebuilt_report) != asdict(expected_report):
        raise ValueError("Resume preflight cannot reconstruct the latest source checkpoint")
    if last_record.get("gapWindowStarts") != [
        format_timestamp(value) for value in rebuilt_gaps
    ]:
        raise ValueError("Resume preflight latest source gap lineage does not match")

    inputs = expected_plan["inputs"]
    if not isinstance(inputs, dict) or not isinstance(inputs.get("archives"), list):
        raise ValueError("Resume preflight plan inputs are invalid")
    archive_inputs = inputs["archives"]
    if len(checkpoints) < len(ordered_archives):
        next_archive = ordered_archives[len(checkpoints)]
        next_archive_input = archive_inputs[len(checkpoints)]
        if not isinstance(next_archive_input, dict):
            raise ValueError("Resume preflight next archive plan record is invalid")
        if sha256_file(next_archive) != next_archive_input.get("expectedSha256"):
            raise ValueError("Resume preflight next source archive digest mismatch")

    final_plan = build_archive_preparation_plan(
        archives=ordered_archives,
        output=output,
        manifest_output=manifest_output,
        options=options,
        acquisition_manifest_path=acquisition_manifest_path,
    )
    if final_plan != expected_plan:
        raise ValueError("Resume preflight inputs changed during validation")
    reports = [report for _, report, _ in checkpoints]
    if output_exists:
        validate_published_output_against_checkpoints(output, checkpoints)
    if manifest_exists:
        validate_completed_dataset_manifest(
            output=output,
            manifest_output=manifest_output,
            checkpoints=checkpoints,
            reports=reports,
            options=options,
            acquisition_manifest_path=acquisition_manifest_path,
        )
    return {
        "schemaVersion": "flippars.archive-resume-admission/1",
        "state": "ArchivePreparation",
        "archiveCount": len(ordered_archives),
        "checkpointCount": len(checkpoints),
        "preparedOutputPresent": output_exists,
        "datasetManifestPresent": manifest_exists,
        "readOnly": True,
    }


def archive_checkpoint_root(output: Path) -> Path:
    return output.parent / f".{output.name}.archive-checkpoints"


def build_archive_preparation_plan(
    *,
    archives: Sequence[Path],
    output: Path,
    manifest_output: Path,
    options: DatasetOptions,
    acquisition_manifest_path: Path | None,
) -> dict[str, object]:
    archive_inputs: list[dict[str, object]] = []
    for archive_index, archive_path in enumerate(archives, start=1):
        if archive_path.is_symlink() or not archive_path.is_file():
            raise ValueError(f"Checkpoint input is not a regular archive: {archive_path}")
        checksum_path = archive_path.with_suffix(archive_path.suffix + ".CHECKSUM")
        expected_sha256, checksum_bytes, checksum_sha256 = read_checksum_snapshot(
            checksum_path, archive_path.name
        )
        archive_inputs.append(
            {
                "archiveIndex": archive_index,
                "path": str(archive_path.resolve()),
                "name": archive_path.name,
                "bytes": archive_path.stat().st_size,
                "expectedSha256": expected_sha256,
                "checksumName": checksum_path.name,
                "checksumBytes": checksum_bytes,
                "checksumSha256": checksum_sha256,
            }
        )
    acquisition_input: dict[str, object] | None = None
    if acquisition_manifest_path is not None:
        if acquisition_manifest_path.is_symlink() or not acquisition_manifest_path.is_file():
            raise ValueError(
                f"Checkpoint acquisition input is not a regular file: "
                f"{acquisition_manifest_path}"
            )
        acquisition_input = {
            "path": str(acquisition_manifest_path.resolve()),
            "bytes": acquisition_manifest_path.stat().st_size,
            "sha256": sha256_file(acquisition_manifest_path),
        }
    pipeline_path = Path(__file__).resolve()
    fingerprint_input = {
        "archives": archive_inputs,
        "acquisitionManifest": acquisition_input,
        "options": asdict(options),
        "output": str(output.resolve()),
        "manifestOutput": str(manifest_output.resolve()),
        "schemas": {
            "dataset": DATASET_SCHEMA_VERSION,
            "datasetManifest": DATASET_MANIFEST_SCHEMA_VERSION,
            "feature": FEATURE_SCHEMA_VERSION,
            "labelPolicy": LABEL_POLICY_VERSION,
            "decisionPolicy": DECISION_POLICY_VERSION,
        },
        "featureNames": list(FEATURE_NAMES),
        "generator": {
            **runtime_metadata(),
            "pipelineSha256": sha256_file(pipeline_path),
        },
    }
    fingerprint = hashlib.sha256(
        canonical_json(fingerprint_input).encode("utf-8")
    ).hexdigest()
    return {
        "schemaVersion": ARCHIVE_PREPARATION_PLAN_SCHEMA_VERSION,
        "fingerprintSha256": fingerprint,
        "inputs": fingerprint_input,
    }


def require_exact_checkpoint_keys(
    value: object, expected: Sequence[str], label: str
) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != set(expected):
        raise ValueError(f"{label} must contain exactly {list(expected)}")
    if not all(isinstance(key, str) for key in value):
        raise ValueError(f"{label} keys must be strings")
    return value


def checkpoint_integer(value: object, label: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValueError(f"{label} must be an integer greater than or equal to {minimum}")
    return value


def checkpoint_optional_string(value: object, label: str) -> str | None:
    if value is not None and (not isinstance(value, str) or not value):
        raise ValueError(f"{label} must be null or a non-empty string")
    return value


def checkpoint_key(value: object, label: str) -> tuple[str, str] | None:
    if value is None:
        return None
    if (
        not isinstance(value, list)
        or len(value) != 2
        or not all(isinstance(part, str) and part for part in value)
    ):
        raise ValueError(f"{label} must be null or a two-string key")
    return value[0], value[1]


def checkpoint_identity_sha256(value: dict[str, object]) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def validate_aligned_gap_window_starts(
    value: object,
    label: str,
    *,
    duration_seconds: int,
    range_start: datetime,
    range_end: datetime,
    require_complete_daily_edges: bool,
) -> list[datetime]:
    if not isinstance(value, list):
        raise ValueError(f"{label} must be an array")
    if duration_seconds <= 0 or 86_400 % duration_seconds != 0:
        raise ValueError(f"{label} uses an invalid aligned duration")
    if range_start.tzinfo is None or range_end.tzinfo is None or range_start >= range_end:
        raise ValueError(f"{label} uses an invalid UTC range")
    texts: list[str] = []
    parsed: list[datetime] = []
    for index, item in enumerate(value):
        if not isinstance(item, str) or not item:
            raise ValueError(f"{label}[{index}] must be a non-empty timestamp string")
        try:
            timestamp = parse_timestamp(item)
        except ValueError as error:
            raise ValueError(f"{label}[{index}] is invalid") from error
        if format_timestamp(timestamp) != item:
            raise ValueError(f"{label}[{index}] is not canonical")
        if timestamp.microsecond != 0 or int(timestamp.timestamp()) % duration_seconds != 0:
            raise ValueError(f"{label}[{index}] is not aligned to the signal duration")
        if not range_start <= timestamp < range_end:
            raise ValueError(f"{label}[{index}] falls outside its source range")
        if require_complete_daily_edges:
            day_start = datetime(
                timestamp.year, timestamp.month, timestamp.day, tzinfo=UTC
            )
            if timestamp == day_start or timestamp + timedelta(
                seconds=duration_seconds
            ) == day_start + timedelta(days=1):
                raise ValueError(f"{label}[{index}] would hide an incomplete daily edge")
        texts.append(item)
        parsed.append(timestamp)
    if texts != sorted(set(texts)):
        raise ValueError(f"{label} must be canonical, strictly ordered, and unique")
    return parsed


def contiguous_candle_tail(
    candles: Sequence[Candle], *, maximum: int = 13
) -> list[Candle]:
    if maximum < 1 or not candles:
        return []
    start = len(candles) - 1
    while start > 0 and len(candles) - start < maximum:
        if candles[start - 1].end != candles[start].start:
            break
        start -= 1
    return list(candles[start:])[-maximum:]


def missing_aligned_candle_windows(
    candles: Sequence[Candle], *, duration_seconds: int
) -> list[datetime]:
    gaps: list[datetime] = []
    for previous, target in zip(candles, candles[1:]):
        if previous.end == target.start:
            continue
        if previous.end > target.start:
            raise ValueError("Candle sequence overlaps or regresses")
        cursor = previous.end
        while cursor < target.start:
            gaps.append(cursor)
            cursor += timedelta(seconds=duration_seconds)
    return gaps


def gap_poisoned_window_starts(
    gap_starts: Sequence[datetime], *, duration_seconds: int
) -> set[str]:
    return {
        format_timestamp(gap + timedelta(seconds=offset * duration_seconds))
        for gap in gap_starts
        for offset in range(14)
    }


def initialize_archive_checkpoint_store(
    checkpoint_root: Path, expected_plan: dict[str, object]
) -> Path:
    plan_path = checkpoint_root / "plan.json"
    archives_root = checkpoint_root / "archives"
    if checkpoint_root.exists():
        if checkpoint_root.is_symlink() or not checkpoint_root.is_dir():
            raise ValueError(f"Invalid archive checkpoint root: {checkpoint_root}")
        actual_names = {entry.name for entry in checkpoint_root.iterdir()}
        if not actual_names:
            archives_root.mkdir(exist_ok=False)
            write_new_json(plan_path, expected_plan)
            return archives_root
        plan_temporaries = [
            entry
            for entry in checkpoint_root.iterdir()
            if ARCHIVE_PLAN_TEMPORARY_PATTERN.fullmatch(entry.name) is not None
        ]
        if len(plan_temporaries) == 1 and actual_names == {
            "archives",
            plan_temporaries[0].name,
        }:
            temporary = plan_temporaries[0]
            if archives_root.is_symlink() or not archives_root.is_dir():
                raise ValueError("Abandoned archive checkpoint store is ambiguous")
            if any(archives_root.iterdir()):
                raise ValueError("Abandoned archive checkpoint store is not empty")
            if temporary.is_symlink() or not temporary.is_file():
                raise ValueError("Abandoned archive checkpoint plan temporary is invalid")
            temporary.unlink()
            write_new_json(plan_path, expected_plan)
            return archives_root
        if actual_names == {"archives"}:
            if archives_root.is_symlink() or not archives_root.is_dir():
                raise ValueError("Abandoned archive checkpoint store is ambiguous")
            if any(archives_root.iterdir()):
                raise ValueError("Abandoned archive checkpoint store is not empty")
            write_new_json(plan_path, expected_plan)
            return archives_root
        if actual_names != {"archives", "plan.json"}:
            raise ValueError("Archive checkpoint root contains unexpected entries")
        if archives_root.is_symlink() or not archives_root.is_dir():
            raise ValueError("Archive checkpoint store is missing its real archives directory")
        if plan_path.is_symlink() or not plan_path.is_file():
            raise ValueError("Archive checkpoint plan is not a regular file")
        actual_plan, _ = read_json_object_and_sha256(plan_path)
        if actual_plan != expected_plan:
            raise ValueError("Archive checkpoint plan does not match current immutable inputs")
        return archives_root
    checkpoint_root.mkdir(parents=False, exist_ok=False)
    try:
        archives_root.mkdir(exist_ok=False)
        write_new_json(plan_path, expected_plan)
    except BaseException:
        shutil.rmtree(checkpoint_root, ignore_errors=True)
        raise
    return archives_root


def validate_checkpoint_report(
    value: object,
    label: str,
    *,
    expected_previous_id: str | None,
    expected_previous_event: str | None,
) -> ArchiveReport:
    expected_fields = tuple(ArchiveReport.__dataclass_fields__)
    report_value = require_exact_checkpoint_keys(value, expected_fields, label)
    try:
        report = ArchiveReport(**report_value)
    except TypeError as error:
        raise ValueError(f"{label} is invalid") from error
    if asdict(report) != report_value:
        raise ValueError(f"{label} does not round-trip exactly")
    string_fields = (
        "archive",
        "symbol",
        "day",
        "archive_sha256",
        "expected_sha256",
        "member",
        "checksum_name",
        "checksum_sha256",
        "normalized_file",
        "normalized_sha256",
    )
    for field_name in string_fields:
        if not isinstance(getattr(report, field_name), str):
            raise ValueError(f"{label}.{field_name} must be a string")
    counter_fields = (
        "archive_bytes",
        "checksum_bytes",
        "accepted_trade_count",
        "rejected_trade_count",
        "duplicate_trade_count",
        "out_of_order_trade_count",
        "missing_trade_id_count",
    )
    for field_name in counter_fields:
        checkpoint_integer(getattr(report, field_name), f"{label}.{field_name}")
    match = ARCHIVE_PATTERN.fullmatch(report.archive)
    if (
        match is None
        or report.symbol != SUPPORTED_SYMBOL
        or match.group("symbol") != report.symbol
        or report.day != match.group("day")
        or report.member != f"{report.archive[:-4]}.csv"
    ):
        raise ValueError(f"{label} archive identity is invalid")
    try:
        report_day = date.fromisoformat(report.day)
    except ValueError as error:
        raise ValueError(f"{label}.day is invalid") from error
    if report_day.isoformat() != report.day:
        raise ValueError(f"{label}.day is not canonical")
    for digest_name in ("archive_sha256", "expected_sha256", "checksum_sha256"):
        if re.fullmatch(r"[a-f0-9]{64}", getattr(report, digest_name)) is None:
            raise ValueError(f"{label}.{digest_name} is invalid")
    if (
        report.archive_bytes < 1
        or not 1 <= report.checksum_bytes <= MAX_CHECKSUM_BYTES
        or report.accepted_trade_count < 1
        or report.rejected_trade_count != 0
        or report.out_of_order_trade_count != 0
        or report.missing_trade_id_count != 0
        or report.missing_trade_id_ranges != []
        or report.normalized_file != ""
        or report.normalized_sha256 != ""
    ):
        raise ValueError(f"{label} counters or streamed-source fields are invalid")
    first_id = checkpoint_optional_string(report.first_trade_id, f"{label}.first_trade_id")
    last_id = checkpoint_optional_string(report.last_trade_id, f"{label}.last_trade_id")
    if (
        first_id is None
        or last_id is None
        or not first_id.isdigit()
        or not last_id.isdigit()
        or int(first_id) < 1
        or int(last_id) < int(first_id)
        or report.accepted_trade_count != int(last_id) - int(first_id) + 1
    ):
        raise ValueError(f"{label} trade-ID range is invalid")
    if expected_previous_id is not None and int(first_id) != int(expected_previous_id) + 1:
        raise ValueError(f"{label} trade-ID chain is discontinuous")
    first_event_text = checkpoint_optional_string(
        report.first_event_at, f"{label}.first_event_at"
    )
    last_event_text = checkpoint_optional_string(
        report.last_event_at, f"{label}.last_event_at"
    )
    if first_event_text is None or last_event_text is None:
        raise ValueError(f"{label} event-time range is missing")
    first_event = parse_timestamp(first_event_text)
    last_event = parse_timestamp(last_event_text)
    day_start = datetime(report_day.year, report_day.month, report_day.day, tzinfo=UTC)
    if (
        format_timestamp(first_event) != first_event_text
        or format_timestamp(last_event) != last_event_text
        or not day_start <= first_event <= last_event < day_start + timedelta(days=1)
    ):
        raise ValueError(f"{label} event-time range is invalid")
    if expected_previous_event is not None and first_event < parse_timestamp(
        expected_previous_event
    ):
        raise ValueError(f"{label} event-time chain regressed")
    return report


def summarize_checkpoint_chunk(
    chunk_path: Path,
    *,
    previous_row_key: tuple[str, str] | None,
    previous_window: str | None,
) -> tuple[dict[str, object], tuple[str, str] | None, str | None]:
    if chunk_path.is_symlink() or not chunk_path.is_file():
        raise ValueError("Archive checkpoint row chunk is not a regular file")
    digest = hashlib.sha256()
    byte_count = 0
    row_count = 0
    window_count = 0
    first_key: tuple[str, str] | None = None
    current_last_key: tuple[str, str] | None = None
    monotonic_key = previous_row_key
    first_window: str | None = None
    current_last_window: str | None = None
    monotonic_window = previous_window
    last_window_end: str | None = None
    with chunk_path.open("rb") as handle:
        for line in handle:
            digest.update(line)
            byte_count += len(line)
            if not line.endswith(b"\n"):
                raise ValueError("Archive checkpoint row chunks must end every row with LF")
            try:
                row = json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValueError("Archive checkpoint row chunk contains invalid JSON") from error
            if not isinstance(row, dict) or (canonical_json(row) + "\n").encode(
                "utf-8"
            ) != line:
                raise ValueError("Archive checkpoint row chunk is not canonically encoded")
            boundary_values = {
                name: row.get(name)
                for name in ("decisionAt", "id", "windowStart", "windowEnd")
            }
            if any(
                not isinstance(value, str) or not value
                for value in boundary_values.values()
            ):
                raise ValueError("Archive checkpoint row boundaries must be non-empty strings")
            key = boundary_values["decisionAt"], boundary_values["id"]
            window = boundary_values["windowStart"]
            if monotonic_key is not None and key <= monotonic_key:
                raise ValueError("Archive checkpoint row keys are not globally monotonic")
            if monotonic_window is not None and window < monotonic_window:
                raise ValueError("Archive checkpoint windows are not globally monotonic")
            if window != monotonic_window:
                window_count += 1
            first_key = first_key or key
            first_window = first_window or window
            current_last_key = key
            current_last_window = window
            monotonic_key = key
            monotonic_window = window
            last_window_end = boundary_values["windowEnd"]
            row_count += 1
    summary = {
        "path": "rows.jsonl",
        "bytes": byte_count,
        "sha256": digest.hexdigest(),
        "rowCount": row_count,
        "windowCount": window_count,
        "firstKey": list(first_key) if first_key is not None else None,
        "lastKey": list(current_last_key) if current_last_key is not None else None,
        "firstWindow": first_window,
        "lastWindow": current_last_window,
        "lastWindowEnd": last_window_end,
    }
    return summary, monotonic_key, monotonic_window


def validate_archive_checkpoint(
    *,
    checkpoint_path: Path,
    chunk_path: Path,
    expected_plan: dict[str, object],
    expected_archive: dict[str, object],
    expected_index: int,
    expected_previous_id: str | None,
    expected_previous_event: str | None,
    expected_previous_checkpoint_sha256: str | None,
    previous_row_key: tuple[str, str] | None,
    previous_window: str | None,
) -> tuple[
    dict[str, object],
    ArchiveReport,
    tuple[str, str] | None,
    str | None,
]:
    record, _ = read_json_object_and_sha256(checkpoint_path)
    require_exact_checkpoint_keys(
        record,
        (
            "schemaVersion",
            "planFingerprintSha256",
            "previousCheckpointSha256",
            "checkpointSha256",
            "archiveIndex",
            "archiveCount",
            "archiveInput",
            "previousState",
            "nextState",
            "gapWindowStarts",
            "rows",
            "report",
        ),
        "archive checkpoint",
    )
    if record["schemaVersion"] != ARCHIVE_PREPARATION_CHECKPOINT_SCHEMA_VERSION:
        raise ValueError("Unsupported archive checkpoint schema")
    if record["planFingerprintSha256"] != expected_plan["fingerprintSha256"]:
        raise ValueError("Archive checkpoint plan fingerprint mismatch")
    previous_checkpoint_sha256 = checkpoint_optional_string(
        record["previousCheckpointSha256"], "previous checkpoint digest"
    )
    if previous_checkpoint_sha256 != expected_previous_checkpoint_sha256:
        raise ValueError("Archive checkpoint digest chain is discontinuous")
    checkpoint_sha256 = record["checkpointSha256"]
    if (
        not isinstance(checkpoint_sha256, str)
        or re.fullmatch(r"[a-f0-9]{64}", checkpoint_sha256) is None
    ):
        raise ValueError("Archive checkpoint identity digest is invalid")
    identity = dict(record)
    del identity["checkpointSha256"]
    if checkpoint_identity_sha256(identity) != checkpoint_sha256:
        raise ValueError("Archive checkpoint identity digest mismatch")
    if checkpoint_integer(record["archiveIndex"], "archiveIndex", minimum=1) != expected_index:
        raise ValueError("Archive checkpoint index mismatch")
    plan_inputs = require_exact_checkpoint_keys(
        expected_plan["inputs"],
        (
            "archives",
            "acquisitionManifest",
            "options",
            "output",
            "manifestOutput",
            "schemas",
            "featureNames",
            "generator",
        ),
        "archive checkpoint plan inputs",
    )
    plan_archives = plan_inputs["archives"]
    if not isinstance(plan_archives, list):
        raise ValueError("Archive checkpoint plan archives must be an array")
    options_value = require_exact_checkpoint_keys(
        plan_inputs["options"],
        tuple(DatasetOptions.__dataclass_fields__),
        "archive checkpoint plan options",
    )
    try:
        options = DatasetOptions(**options_value)
        validate_dataset_options(options)
    except (TypeError, ValueError) as error:
        raise ValueError("Archive checkpoint plan options are invalid") from error
    if checkpoint_integer(record["archiveCount"], "archiveCount", minimum=1) != len(
        plan_archives
    ):
        raise ValueError("Archive checkpoint count mismatch")
    if record["archiveInput"] != expected_archive:
        raise ValueError("Archive checkpoint input identity mismatch")
    previous_state = require_exact_checkpoint_keys(
        record["previousState"], ("lastTradeId", "lastEventAt"), "previous state"
    )
    previous_id = checkpoint_optional_string(
        previous_state["lastTradeId"], "previous lastTradeId"
    )
    previous_event = checkpoint_optional_string(
        previous_state["lastEventAt"], "previous lastEventAt"
    )
    if previous_id != expected_previous_id or previous_event != expected_previous_event:
        raise ValueError("Archive checkpoint state chain is discontinuous")
    next_state = require_exact_checkpoint_keys(
        record["nextState"], ("lastTradeId", "lastEventAt"), "next state"
    )
    next_id = checkpoint_optional_string(next_state["lastTradeId"], "next lastTradeId")
    next_event = checkpoint_optional_string(next_state["lastEventAt"], "next lastEventAt")
    report = validate_checkpoint_report(
        record["report"],
        "archive checkpoint report",
        expected_previous_id=expected_previous_id,
        expected_previous_event=expected_previous_event,
    )
    if (
        report.archive != expected_archive["name"]
        or report.archive_sha256 != expected_archive["expectedSha256"]
        or report.expected_sha256 != expected_archive["expectedSha256"]
        or report.archive_bytes != expected_archive["bytes"]
        or report.checksum_name != expected_archive["checksumName"]
        or report.checksum_bytes != expected_archive["checksumBytes"]
        or report.checksum_sha256 != expected_archive["checksumSha256"]
        or report.last_trade_id != next_id
        or report.last_event_at != next_event
        or report.missing_trade_id_count != 0
    ):
        raise ValueError("Archive checkpoint report does not match its immutable input")
    report_day = date.fromisoformat(report.day)
    day_start = datetime(report_day.year, report_day.month, report_day.day, tzinfo=UTC)
    validate_aligned_gap_window_starts(
        record["gapWindowStarts"],
        "archive checkpoint gapWindowStarts",
        duration_seconds=SIGNAL_DURATION_SECONDS[options.signal_type],
        range_start=day_start,
        range_end=day_start + timedelta(days=1),
        require_complete_daily_edges=True,
    )
    rows = require_exact_checkpoint_keys(
        record["rows"],
        (
            "path",
            "bytes",
            "sha256",
            "rowCount",
            "windowCount",
            "firstKey",
            "lastKey",
            "firstWindow",
            "lastWindow",
            "lastWindowEnd",
        ),
        "archive checkpoint rows",
    )
    if rows["path"] != "rows.jsonl":
        raise ValueError("Archive checkpoint row path is invalid")
    row_bytes = checkpoint_integer(rows["bytes"], "row bytes")
    row_count = checkpoint_integer(rows["rowCount"], "row count")
    window_count = checkpoint_integer(rows["windowCount"], "window count")
    digest = rows["sha256"]
    if not isinstance(digest, str) or re.fullmatch(r"[a-f0-9]{64}", digest) is None:
        raise ValueError("Archive checkpoint row digest is invalid")
    if chunk_path.is_symlink() or not chunk_path.is_file():
        raise ValueError("Archive checkpoint row chunk is not a regular file")
    if chunk_path.stat().st_size != row_bytes:
        raise ValueError("Archive checkpoint row chunk hash or size mismatch")
    first_key = checkpoint_key(rows["firstKey"], "first row key")
    last_key = checkpoint_key(rows["lastKey"], "last row key")
    first_window = checkpoint_optional_string(rows["firstWindow"], "first window")
    last_window = checkpoint_optional_string(rows["lastWindow"], "last window")
    last_window_end = checkpoint_optional_string(rows["lastWindowEnd"], "last window end")
    if row_count == 0:
        if window_count != 0 or any(
            value is not None
            for value in (first_key, last_key, first_window, last_window, last_window_end)
        ):
            raise ValueError("Empty archive checkpoint has non-empty row boundaries")
    else:
        if window_count < 1 or window_count > row_count:
            raise ValueError("Archive checkpoint window count is inconsistent")
        if any(
            value is None
            for value in (first_key, last_key, first_window, last_window, last_window_end)
        ):
            raise ValueError("Non-empty archive checkpoint is missing row boundaries")
        if first_key > last_key or first_window > last_window:
            raise ValueError("Archive checkpoint row boundaries are inconsistent")
    if first_key is not None and previous_row_key is not None and first_key <= previous_row_key:
        raise ValueError("Archive checkpoint row keys are not globally monotonic")
    if first_window is not None and previous_window is not None and first_window < previous_window:
        raise ValueError("Archive checkpoint windows are not globally monotonic")
    observed_rows, observed_last_key, observed_last_window = summarize_checkpoint_chunk(
        chunk_path,
        previous_row_key=previous_row_key,
        previous_window=previous_window,
    )
    if rows != observed_rows:
        raise ValueError("Archive checkpoint row summary does not match canonical chunk bytes")
    return record, report, observed_last_key, observed_last_window


def assert_real_directory_tree(path: Path, label: str) -> None:
    pending = [path]
    while pending:
        current = pending.pop()
        for entry in current.iterdir():
            metadata = entry.lstat()
            file_attributes = int(getattr(metadata, "st_file_attributes", 0))
            reparse_attribute = int(
                getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
            )
            if stat.S_ISLNK(metadata.st_mode) or (
                reparse_attribute and file_attributes & reparse_attribute
            ):
                raise ValueError(f"{label} contains a link or reparse point")
            if entry.is_dir():
                pending.append(entry)


def load_archive_checkpoints(
    *,
    archives_root: Path,
    expected_plan: dict[str, object],
    discard_abandoned_temporaries: bool = True,
) -> list[tuple[dict[str, object], ArchiveReport, Path]]:
    entries_to_validate: list[Path] = []
    for entry in list(archives_root.iterdir()):
        if ARCHIVE_CHECKPOINT_TEMPORARY_PATTERN.fullmatch(entry.name) is not None:
            if entry.is_symlink() or not entry.is_dir():
                raise ValueError("Invalid abandoned archive checkpoint temporary entry")
            assert_real_directory_tree(
                entry, "Abandoned archive checkpoint temporary entry"
            )
            if discard_abandoned_temporaries:
                shutil.rmtree(entry)
            continue
        entries_to_validate.append(entry)
    entries = sorted(entries_to_validate, key=lambda path: path.name)
    if any(
        entry.is_symlink()
        or not entry.is_dir()
        or ARCHIVE_CHECKPOINT_DIRECTORY_PATTERN.fullmatch(entry.name) is None
        for entry in entries
    ):
        raise ValueError("Archive checkpoint store contains an unexpected entry")
    inputs = require_exact_checkpoint_keys(
        expected_plan["inputs"],
        (
            "archives",
            "acquisitionManifest",
            "options",
            "output",
            "manifestOutput",
            "schemas",
            "featureNames",
            "generator",
        ),
        "archive checkpoint plan inputs",
    )
    archive_inputs = inputs["archives"]
    if not isinstance(archive_inputs, list) or len(entries) > len(archive_inputs):
        raise ValueError("Archive checkpoint count exceeds the immutable plan")
    checkpoints: list[tuple[dict[str, object], ArchiveReport, Path]] = []
    previous_id: str | None = None
    previous_event: str | None = None
    previous_row_key: tuple[str, str] | None = None
    previous_window: str | None = None
    previous_checkpoint_sha256: str | None = None
    for expected_index, entry in enumerate(entries, start=1):
        if entry.name != f"{expected_index:08d}":
            raise ValueError("Archive checkpoints must form one contiguous prefix")
        actual_names = {child.name for child in entry.iterdir()}
        if actual_names != {"checkpoint.json", "rows.jsonl"}:
            raise ValueError("Archive checkpoint directory contains unexpected entries")
        if (entry / "checkpoint.json").is_symlink() or not (
            entry / "checkpoint.json"
        ).is_file():
            raise ValueError("Archive checkpoint metadata is not a regular file")
        expected_archive = archive_inputs[expected_index - 1]
        if not isinstance(expected_archive, dict):
            raise ValueError("Archive checkpoint plan contains an invalid archive record")
        record, report, previous_row_key, previous_window = validate_archive_checkpoint(
            checkpoint_path=entry / "checkpoint.json",
            chunk_path=entry / "rows.jsonl",
            expected_plan=expected_plan,
            expected_archive=expected_archive,
            expected_index=expected_index,
            expected_previous_id=previous_id,
            expected_previous_event=previous_event,
            expected_previous_checkpoint_sha256=previous_checkpoint_sha256,
            previous_row_key=previous_row_key,
            previous_window=previous_window,
        )
        next_state = record["nextState"]
        if not isinstance(next_state, dict):
            raise ValueError("Archive checkpoint next state is invalid")
        previous_id = checkpoint_optional_string(next_state["lastTradeId"], "lastTradeId")
        previous_event = checkpoint_optional_string(next_state["lastEventAt"], "lastEventAt")
        previous_checkpoint_sha256 = checkpoint_optional_string(
            record["checkpointSha256"], "checkpoint digest"
        )
        checkpoints.append((record, report, entry / "rows.jsonl"))
    return checkpoints


def collect_checkpoint_gap_window_starts(
    checkpoints: Sequence[tuple[dict[str, object], ArchiveReport, Path]],
    options: DatasetOptions,
) -> list[datetime]:
    duration_seconds = SIGNAL_DURATION_SECONDS[options.signal_type]
    result: list[datetime] = []
    for record, report, _ in checkpoints:
        report_day = date.fromisoformat(report.day)
        day_start = datetime(report_day.year, report_day.month, report_day.day, tzinfo=UTC)
        result.extend(
            validate_aligned_gap_window_starts(
                record.get("gapWindowStarts"),
                f"Archive {report.archive} checkpoint gapWindowStarts",
                duration_seconds=duration_seconds,
                range_start=day_start,
                range_end=day_start + timedelta(days=1),
                require_complete_daily_edges=True,
            )
        )
    texts = [format_timestamp(value) for value in result]
    if texts != sorted(set(texts)):
        raise ValueError("Archive checkpoint gaps must be globally ordered and unique")
    return result


def prepare_archive_batch(
    *,
    archive_path: Path,
    options: DatasetOptions,
    history_tail: Sequence[Candle],
    previous_day_last_id: str | None,
    previous_day_last_event: datetime | None,
) -> tuple[ArchiveReport, list[Candle], list[dict[str, object]], list[datetime]]:
    report, candles = stream_archive_candles(
        archive_path,
        options,
        previous_day_last_id=previous_day_last_id,
        previous_day_last_event=previous_day_last_event,
    )
    report_day = date.fromisoformat(report.day)
    expected_day_start = datetime(report_day.year, report_day.month, report_day.day, tzinfo=UTC)
    if (
        not candles
        or candles[0].start != expected_day_start
        or candles[-1].end != expected_day_start + timedelta(days=1)
    ):
        raise ValueError(f"Archive {report.archive} does not cover its complete aligned UTC day")
    if report.missing_trade_id_count:
        raise ValueError(
            f"Detected {report.missing_trade_id_count} missing Binance trade IDs; "
            "source corpus is quarantined"
        )
    sequence = list(history_tail) + candles
    duration_seconds = SIGNAL_DURATION_SECONDS[options.signal_type]
    gaps = missing_aligned_candle_windows(
        sequence, duration_seconds=duration_seconds
    )
    validate_aligned_gap_window_starts(
        [format_timestamp(gap) for gap in gaps],
        f"Archive {report.archive} gapWindowStarts",
        duration_seconds=duration_seconds,
        range_start=expected_day_start,
        range_end=expected_day_start + timedelta(days=1),
        require_complete_daily_edges=True,
    )
    owned_window_starts = {format_timestamp(candle.start) for candle in candles}
    rows = [
        row
        for row in examples_from_candles(sequence, options)
        if str(row["windowStart"]) in owned_window_starts
    ]
    return report, candles, rows, gaps


def write_archive_checkpoint(
    *,
    archives_root: Path,
    expected_plan: dict[str, object],
    archive_input: dict[str, object],
    archive_index: int,
    archive_count: int,
    rows: Sequence[dict[str, object]],
    gap_starts: Sequence[datetime],
    report: ArchiveReport,
    previous_id: str | None,
    previous_event: str | None,
    previous_checkpoint_sha256: str | None,
    previous_row_key: tuple[str, str] | None,
    previous_window: str | None,
) -> dict[str, object]:
    final_directory = archives_root / f"{archive_index:08d}"
    if final_directory.exists():
        raise FileExistsError(f"Refusing to overwrite archive checkpoint: {final_directory}")
    temporary_directory = Path(
        tempfile.mkdtemp(prefix=f".{archive_index:08d}.", suffix=".part", dir=archives_root)
    )
    try:
        chunk_path = temporary_directory / "rows.jsonl"
        digest = hashlib.sha256()
        byte_count = 0
        row_count = 0
        window_count = 0
        first_key: tuple[str, str] | None = None
        last_key = previous_row_key
        first_window: str | None = None
        last_window = previous_window
        last_window_end: str | None = None
        with chunk_path.open("xb") as handle:
            for row in rows:
                key = str(row["decisionAt"]), str(row["id"])
                if last_key is not None and key <= last_key:
                    raise ValueError("Prepared rows must have unique monotonic IDs")
                window = str(row["windowStart"])
                if last_window is not None and window < last_window:
                    raise ValueError("Prepared windows must be monotonic")
                if window != last_window:
                    window_count += 1
                first_key = first_key or key
                first_window = first_window or window
                last_key = key
                last_window = window
                last_window_end = str(row["windowEnd"])
                payload = (canonical_json(row) + "\n").encode("utf-8")
                handle.write(payload)
                digest.update(payload)
                byte_count += len(payload)
                row_count += 1
            handle.flush()
            os.fsync(handle.fileno())
        record = {
            "schemaVersion": ARCHIVE_PREPARATION_CHECKPOINT_SCHEMA_VERSION,
            "planFingerprintSha256": expected_plan["fingerprintSha256"],
            "previousCheckpointSha256": previous_checkpoint_sha256,
            "archiveIndex": archive_index,
            "archiveCount": archive_count,
            "archiveInput": archive_input,
            "previousState": {
                "lastTradeId": previous_id,
                "lastEventAt": previous_event,
            },
            "nextState": {
                "lastTradeId": report.last_trade_id,
                "lastEventAt": report.last_event_at,
            },
            "gapWindowStarts": [format_timestamp(value) for value in gap_starts],
            "rows": {
                "path": "rows.jsonl",
                "bytes": byte_count,
                "sha256": digest.hexdigest(),
                "rowCount": row_count,
                "windowCount": window_count,
                "firstKey": list(first_key) if first_key is not None else None,
                "lastKey": list(last_key) if row_count else None,
                "firstWindow": first_window,
                "lastWindow": last_window if row_count else None,
                "lastWindowEnd": last_window_end,
            },
            "report": asdict(report),
        }
        record["checkpointSha256"] = checkpoint_identity_sha256(record)
        write_new_json(temporary_directory / "checkpoint.json", record)
        temporary_directory.rename(final_directory)
        return record
    except BaseException:
        shutil.rmtree(temporary_directory, ignore_errors=True)
        raise


def iter_checkpoint_rows(
    checkpoints: Sequence[tuple[dict[str, object], ArchiveReport, Path]],
) -> Iterator[dict[str, object]]:
    for record, _, chunk_path in checkpoints:
        rows = record["rows"]
        if not isinstance(rows, dict):
            raise ValueError("Archive checkpoint rows are invalid")
        expected_count = checkpoint_integer(rows["rowCount"], "row count")
        observed_count = 0
        with chunk_path.open("rb") as handle:
            for line in handle:
                if not line.endswith(b"\n"):
                    raise ValueError("Archive checkpoint row chunks must end every row with LF")
                try:
                    row = json.loads(line.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise ValueError("Archive checkpoint row chunk contains invalid JSON") from error
                if not isinstance(row, dict) or (canonical_json(row) + "\n").encode("utf-8") != line:
                    raise ValueError("Archive checkpoint row chunk is not canonically encoded")
                observed_count += 1
                yield row
        if observed_count != expected_count:
            raise ValueError("Archive checkpoint row count mismatch")


def iter_gap_abstaining_rows(
    rows: Iterable[dict[str, object]],
    gap_starts: Sequence[datetime],
    options: DatasetOptions,
) -> Iterator[dict[str, object]]:
    forbidden = gap_poisoned_window_starts(
        gap_starts,
        duration_seconds=SIGNAL_DURATION_SECONDS[options.signal_type],
    )
    for row in rows:
        window = row.get("windowStart")
        if not isinstance(window, str) or not window:
            raise ValueError("Prepared row is missing its windowStart")
        if window in forbidden:
            raise ValueError(
                f"Prepared window {window} depends on a declared source gap"
            )
        yield row


def validate_published_output_against_checkpoints(
    output: Path,
    checkpoints: Sequence[tuple[dict[str, object], ArchiveReport, Path]],
) -> None:
    if output.is_symlink() or not output.is_file():
        raise ValueError("Published prepared output is not a regular file")
    expected_digest = hashlib.sha256()
    observed_digest = hashlib.sha256()
    expected_bytes = 0
    with output.open("rb") as observed:
        for _, _, chunk_path in checkpoints:
            with chunk_path.open("rb") as expected:
                for block in iter(lambda: expected.read(1_048_576), b""):
                    observed_block = observed.read(len(block))
                    expected_digest.update(block)
                    observed_digest.update(observed_block)
                    expected_bytes += len(block)
                    if observed_block != block:
                        raise ValueError(
                            "Published prepared output does not match checkpoint bytes"
                        )
        if observed.read(1):
            raise ValueError("Published prepared output has bytes beyond its checkpoints")
    if (
        output.stat().st_size != expected_bytes
        or observed_digest.hexdigest() != expected_digest.hexdigest()
    ):
        raise ValueError("Published prepared output hash or size does not match checkpoints")


def remove_abandoned_finalization_temporaries(
    targets: Sequence[Path],
    *,
    checkpoint_root_was_present: bool,
    checkpoints_complete: bool,
    remove: bool = True,
) -> None:
    candidates: list[Path] = []
    for target in targets:
        prefix = f".{target.name}."
        pattern = re.compile(
            rf"^\.{re.escape(target.name)}\."
            rf"{CHECKPOINT_SAFE_TEMPORARY_TOKEN}\.part$"
        )
        target_candidates = [
            entry
            for entry in target.parent.iterdir()
            if entry.name.startswith(prefix) and entry.name.endswith(".part")
        ]
        if len(target_candidates) > 1:
            raise ValueError(f"Ambiguous abandoned temporary files for {target.name}")
        for entry in target_candidates:
            if pattern.fullmatch(entry.name) is None:
                raise ValueError(f"Ambiguous abandoned temporary name: {entry.name}")
            if entry.is_symlink() or not entry.is_file():
                raise ValueError(f"Abandoned temporary is not a regular file: {entry.name}")
            candidates.append(entry)
    if candidates and (not checkpoint_root_was_present or not checkpoints_complete):
        raise ValueError("Abandoned finalization temporaries lack complete checkpoints")
    if remove:
        for candidate in candidates:
            candidate.unlink()


def validate_completed_dataset_manifest(
    *,
    output: Path,
    manifest_output: Path,
    checkpoints: Sequence[tuple[dict[str, object], ArchiveReport, Path]],
    reports: Sequence[ArchiveReport],
    options: DatasetOptions,
    acquisition_manifest_path: Path | None,
) -> dict[str, object]:
    manifest, _ = read_json_object_and_sha256(manifest_output)
    validate_dataset_manifest(manifest)
    row_count = 0
    window_count = 0
    first_decision_at: str | None = None
    last_window_end: str | None = None
    for record, _, _ in checkpoints:
        rows = record["rows"]
        if not isinstance(rows, dict):
            raise ValueError("Completed checkpoint row summary is invalid")
        row_count += checkpoint_integer(rows["rowCount"], "row count")
        window_count += checkpoint_integer(rows["windowCount"], "window count")
        first_key = checkpoint_key(rows["firstKey"], "first row key")
        if first_decision_at is None and first_key is not None:
            first_decision_at = first_key[0]
        checkpoint_last_end = checkpoint_optional_string(
            rows["lastWindowEnd"], "last window end"
        )
        if checkpoint_last_end is not None:
            last_window_end = checkpoint_last_end
    model_fit_end = int(window_count * 0.6)
    calibration_end = int(window_count * 0.8)
    partition_window_counts = {
        "modelFit": model_fit_end,
        "calibration": calibration_end - model_fit_end,
        "evaluation": window_count - calibration_end,
    }
    report_days = [date.fromisoformat(report.day) for report in reports]
    source_start = report_days[0].isoformat() if report_days else None
    source_end = (
        (report_days[-1] + timedelta(days=1)).isoformat() if report_days else None
    )
    expected_acquisition = (
        validate_acquisition_evidence(
            acquisition_manifest_path,
            reports,
            source_start,
            source_end,
        )
        if acquisition_manifest_path is not None
        else None
    )
    source = manifest["source"]
    if not isinstance(source, dict):
        raise ValueError("Completed dataset manifest source is invalid")
    expected_lineage = (
        "PUBLIC_BINANCE_ARCHIVE"
        if acquisition_manifest_path is not None
        else "LOCAL_ARCHIVE_REPLAY"
    )
    source_bindings = {
        "lineageKind": expected_lineage,
        "startDateInclusive": source_start,
        "endDateExclusive": source_end,
        "dayCount": len(reports),
        "acquisitionEvidence": expected_acquisition,
        "archives": [asdict(report) for report in reports],
    }
    if any(source.get(key) != value for key, value in source_bindings.items()):
        raise ValueError("Completed dataset manifest source binding mismatch")
    gap_starts = collect_checkpoint_gap_window_starts(checkpoints, options)
    gap_window_starts = [format_timestamp(value) for value in gap_starts]
    output_sha256 = sha256_file(output)
    expected_bindings = {
        "target": target_contract_for_options(options),
        "options": asdict(options),
        "startAt": first_decision_at,
        "endAt": last_window_end,
        "acceptedTradeCount": sum(report.accepted_trade_count for report in reports),
        "rejectedTradeCount": sum(report.rejected_trade_count for report in reports),
        "gapCount": len(gap_window_starts),
        "gapWindowStarts": gap_window_starts,
        "duplicateTradeCount": sum(report.duplicate_trade_count for report in reports),
        "preparedDecisionRowCount": row_count,
        "preparedWindowCount": window_count,
        "windowCountUnit": "UNIQUE_WINDOW_START",
        "partitionWindowCounts": partition_window_counts,
        "preparedDatasetSha256": output_sha256,
        "generator": runtime_metadata(),
    }
    if any(manifest.get(key) != value for key, value in expected_bindings.items()):
        raise ValueError("Completed dataset manifest output binding mismatch")
    return {
        "rows": row_count,
        "output": str(output.resolve()),
        "manifest": str(manifest_output.resolve()),
        "datasetContentSha256": output_sha256,
        "gapCount": len(gap_window_starts),
        "rejectedTradeCount": expected_bindings["rejectedTradeCount"],
        "duplicateTradeCount": expected_bindings["duplicateTradeCount"],
    }


def write_resumable_archive_dataset(
    *,
    archives: Sequence[Path],
    output: Path,
    manifest_output: Path,
    options: DatasetOptions,
    acquisition_manifest_path: Path | None,
) -> dict[str, object]:
    output.parent.mkdir(parents=True, exist_ok=True)
    checkpoint_root = archive_checkpoint_root(output)
    checkpoint_root_was_present = checkpoint_root.exists()
    output_exists = output.exists()
    manifest_exists = manifest_output.exists()
    reconciling_completed_outputs = output_exists and manifest_exists
    recovering_published_output = output_exists and not manifest_exists
    if manifest_exists and not output_exists:
        raise FileExistsError(
            f"Refusing dataset manifest without prepared output: {manifest_output}"
        )
    if (recovering_published_output or reconciling_completed_outputs) and not (
        checkpoint_root.is_dir()
    ):
        raise FileExistsError(
            f"Refusing completed or published dataset without checkpoints: {output}"
        )
    if reconciling_completed_outputs:
        if output.is_symlink() or not output.is_file():
            raise ValueError("Completed prepared output is not a regular file")
        if manifest_output.is_symlink() or not manifest_output.is_file():
            raise ValueError("Completed dataset manifest is not a regular file")
        if checkpoint_root.is_symlink() or {
            entry.name for entry in checkpoint_root.iterdir()
        } != {"archives", "plan.json"}:
            raise ValueError("Completed dataset checkpoint state is not normal")
        if output.parent == manifest_output.parent and {
            entry.name for entry in output.parent.iterdir()
        } != {output.name, manifest_output.name, checkpoint_root.name}:
            raise ValueError("Completed dataset directory contains unexpected entries")
    expected_plan = build_archive_preparation_plan(
        archives=archives,
        output=output,
        manifest_output=manifest_output,
        options=options,
        acquisition_manifest_path=acquisition_manifest_path,
    )
    archives_root = initialize_archive_checkpoint_store(checkpoint_root, expected_plan)
    checkpoints = load_archive_checkpoints(
        archives_root=archives_root,
        expected_plan=expected_plan,
    )
    if (
        recovering_published_output or reconciling_completed_outputs
    ) and len(checkpoints) != len(archives):
        raise ValueError(
            "Published or completed output cannot use incomplete checkpoints"
        )
    inputs = expected_plan["inputs"]
    if not isinstance(inputs, dict) or not isinstance(inputs.get("archives"), list):
        raise ValueError("Archive checkpoint plan inputs are invalid")
    archive_inputs = inputs["archives"]
    reports = [report for _, report, _ in checkpoints]
    history_tail: list[Candle] = []
    previous_id: str | None = None
    previous_event: str | None = None
    previous_row_key: tuple[str, str] | None = None
    previous_window: str | None = None
    previous_checkpoint_sha256: str | None = None
    if checkpoints:
        last_record, expected_report, _ = checkpoints[-1]
        previous_state = last_record["previousState"]
        next_state = last_record["nextState"]
        if not isinstance(previous_state, dict) or not isinstance(next_state, dict):
            raise ValueError("Archive checkpoint state is invalid")
        before_id = checkpoint_optional_string(previous_state["lastTradeId"], "lastTradeId")
        before_event = checkpoint_optional_string(previous_state["lastEventAt"], "lastEventAt")
        rebuilt_report, rebuilt_candles, _, rebuilt_gaps = prepare_archive_batch(
            archive_path=archives[len(checkpoints) - 1],
            options=options,
            history_tail=[],
            previous_day_last_id=before_id,
            previous_day_last_event=parse_timestamp(before_event) if before_event else None,
        )
        if asdict(rebuilt_report) != asdict(expected_report):
            raise ValueError("Last archive checkpoint cannot reconstruct its source state")
        expected_gap_starts = last_record.get("gapWindowStarts")
        rebuilt_gap_starts = [format_timestamp(value) for value in rebuilt_gaps]
        if expected_gap_starts != rebuilt_gap_starts:
            raise ValueError("Last archive checkpoint gap lineage does not match its source")
        history_tail = contiguous_candle_tail(rebuilt_candles)
        previous_id = checkpoint_optional_string(next_state["lastTradeId"], "lastTradeId")
        previous_event = checkpoint_optional_string(next_state["lastEventAt"], "lastEventAt")
        previous_checkpoint_sha256 = checkpoint_optional_string(
            last_record["checkpointSha256"], "checkpoint digest"
        )
        for record, _, _ in reversed(checkpoints):
            row_summary = record["rows"]
            if not isinstance(row_summary, dict):
                raise ValueError("Archive checkpoint row summary is invalid")
            key = checkpoint_key(row_summary["lastKey"], "last row key")
            window = checkpoint_optional_string(row_summary["lastWindow"], "last window")
            if previous_row_key is None and key is not None:
                previous_row_key = key
            if previous_window is None and window is not None:
                previous_window = window
            if previous_row_key is not None and previous_window is not None:
                break
        print(
            f"Resuming after {len(checkpoints)}/{len(archives)} verified daily archives...",
            file=sys.stderr,
            flush=True,
        )
    for archive_index in range(len(checkpoints) + 1, len(archives) + 1):
        archive_path = archives[archive_index - 1]
        report, candles, rows, gaps = prepare_archive_batch(
            archive_path=archive_path,
            options=options,
            history_tail=history_tail,
            previous_day_last_id=previous_id,
            previous_day_last_event=parse_timestamp(previous_event) if previous_event else None,
        )
        record = write_archive_checkpoint(
            archives_root=archives_root,
            expected_plan=expected_plan,
            archive_input=archive_inputs[archive_index - 1],
            archive_index=archive_index,
            archive_count=len(archives),
            rows=rows,
            gap_starts=gaps,
            report=report,
            previous_id=previous_id,
            previous_event=previous_event,
            previous_checkpoint_sha256=previous_checkpoint_sha256,
            previous_row_key=previous_row_key,
            previous_window=previous_window,
        )
        reports.append(report)
        checkpoints.append((record, report, archives_root / f"{archive_index:08d}" / "rows.jsonl"))
        history_tail = contiguous_candle_tail(history_tail + candles)
        previous_id = report.last_trade_id
        previous_event = report.last_event_at
        previous_checkpoint_sha256 = checkpoint_optional_string(
            record["checkpointSha256"], "checkpoint digest"
        )
        row_summary = record["rows"]
        if not isinstance(row_summary, dict):
            raise ValueError("Archive checkpoint row summary is invalid")
        new_key = checkpoint_key(row_summary["lastKey"], "last row key")
        new_window = checkpoint_optional_string(row_summary["lastWindow"], "last window")
        previous_row_key = new_key or previous_row_key
        previous_window = new_window or previous_window
        if archive_index % 25 == 0 or archive_index == len(archives):
            print(
                f"Prepared {archive_index}/{len(archives)} verified daily archives...",
                file=sys.stderr,
                flush=True,
            )
    final_plan = build_archive_preparation_plan(
        archives=archives,
        output=output,
        manifest_output=manifest_output,
        options=options,
        acquisition_manifest_path=acquisition_manifest_path,
    )
    if final_plan != expected_plan:
        raise ValueError("Archive preparation inputs changed before finalization")
    if reconciling_completed_outputs:
        validate_published_output_against_checkpoints(output, checkpoints)
        existing_result = validate_completed_dataset_manifest(
            output=output,
            manifest_output=manifest_output,
            checkpoints=checkpoints,
            reports=reports,
            options=options,
            acquisition_manifest_path=acquisition_manifest_path,
        )
        return existing_result
    if recovering_published_output:
        validate_published_output_against_checkpoints(output, checkpoints)
    remove_abandoned_finalization_temporaries(
        (output, manifest_output),
        checkpoint_root_was_present=checkpoint_root_was_present,
        checkpoints_complete=len(checkpoints) == len(archives),
    )
    if recovering_published_output:
        output.unlink()
        print(
            "Verified and removed an unpublished prepared output; replaying finalization...",
            file=sys.stderr,
            flush=True,
        )
    gap_starts = collect_checkpoint_gap_window_starts(checkpoints, options)
    result = write_prepared_dataset(
        rows=iter_gap_abstaining_rows(
            iter_checkpoint_rows(checkpoints), gap_starts, options
        ),
        trades_accepted=None,
        cross_file_duplicates=0,
        reports=reports,
        gap_starts=gap_starts,
        output=output,
        manifest_output=manifest_output,
        options=options,
        lineage_kind=(
            "PUBLIC_BINANCE_ARCHIVE"
            if acquisition_manifest_path is not None
            else "LOCAL_ARCHIVE_REPLAY"
        ),
        acquisition_manifest_path=acquisition_manifest_path,
    )
    return result


def select_offline_archives(archive_root: Path, start: date, end: date) -> list[Path]:
    if end <= start:
        raise ValueError("end must be later than start")
    if not archive_root.is_dir() or archive_root.is_symlink():
        raise ValueError(f"Offline archive root must be a real directory: {archive_root}")
    expected_archives = [
        archive_root / f"{SUPPORTED_SYMBOL}-trades-{day.isoformat()}.zip"
        for day in (start + timedelta(days=offset) for offset in range((end - start).days))
    ]
    expected_names = {
        name
        for archive in expected_archives
        for name in (archive.name, f"{archive.name}.CHECKSUM")
    }
    entries = list(archive_root.iterdir())
    actual_names = {entry.name for entry in entries}
    if len(actual_names) != len(entries):
        raise ValueError("Offline archive root contains duplicate names")
    missing = sorted(expected_names - actual_names)
    extra = sorted(actual_names - expected_names)
    if missing or extra:
        raise ValueError(
            f"Offline archive root differs from the requested range; "
            f"missing={missing[:5]}, extra={extra[:5]}"
        )
    for entry in entries:
        if entry.is_symlink() or not entry.is_file():
            raise ValueError(f"Offline archive entry is not a regular file: {entry.name}")
    return expected_archives


def iter_archive_rows(
    archives: Sequence[Path],
    options: DatasetOptions,
    reports: list[ArchiveReport],
    gap_starts: list[datetime],
) -> Iterator[dict[str, object]]:
    duration_seconds = SIGNAL_DURATION_SECONDS[options.signal_type]
    history_tail: list[Candle] = []
    previous_day_last_id: str | None = None
    previous_day_last_event: datetime | None = None
    for archive_index, archive_path in enumerate(archives, start=1):
        report, candles = stream_archive_candles(
            archive_path,
            options,
            previous_day_last_id=previous_day_last_id,
            previous_day_last_event=previous_day_last_event,
        )
        report_day = date.fromisoformat(report.day)
        expected_day_start = datetime(
            report_day.year, report_day.month, report_day.day, tzinfo=UTC
        )
        if (
            not candles
            or candles[0].start != expected_day_start
            or candles[-1].end != expected_day_start + timedelta(days=1)
        ):
            raise ValueError(
                f"Archive {report.archive} does not cover its complete aligned UTC day"
            )
        reports.append(report)
        if report.missing_trade_id_count:
            raise ValueError(
                f"Detected {report.missing_trade_id_count} missing Binance trade IDs; "
                "source corpus is quarantined"
            )
        if candles:
            previous_day_last_id = str(getattr(candles[-1], "_last_trade_id"))
            previous_day_last_event = parse_timestamp(str(report.last_event_at))
        sequence = history_tail + candles
        archive_gaps = missing_aligned_candle_windows(
            sequence, duration_seconds=duration_seconds
        )
        validate_aligned_gap_window_starts(
            [format_timestamp(gap) for gap in archive_gaps],
            f"Archive {report.archive} gapWindowStarts",
            duration_seconds=duration_seconds,
            range_start=expected_day_start,
            range_end=expected_day_start + timedelta(days=1),
            require_complete_daily_edges=True,
        )
        gap_starts.extend(archive_gaps)
        owned_window_starts = {format_timestamp(candle.start) for candle in candles}
        for row in examples_from_candles(sequence, options):
            if str(row["windowStart"]) in owned_window_starts:
                yield row
        if candles:
            history_tail = contiguous_candle_tail(sequence)
        if archive_index % 25 == 0 or archive_index == len(archives):
            print(
                f"Prepared {archive_index}/{len(archives)} verified daily archives...",
                file=sys.stderr,
                flush=True,
            )


def stream_archive_candles(
    archive_path: Path,
    options: DatasetOptions,
    *,
    previous_day_last_id: str | None,
    previous_day_last_event: datetime | None,
) -> tuple[ArchiveReport, list[Candle]]:
    match = ARCHIVE_PATTERN.fullmatch(archive_path.name)
    if not match:
        raise ValueError(f"Unsupported archive filename: {archive_path.name}")
    symbol = validate_symbol(match.group("symbol"))
    day = date.fromisoformat(match.group("day"))
    member_name = validate_archive_identity(archive_path, symbol, day)
    checksum_path = archive_path.with_suffix(archive_path.suffix + ".CHECKSUM")
    expected_checksum, checksum_bytes, checksum_sha256 = read_checksum_snapshot(
        checksum_path, archive_path.name
    )
    archive_bytes = archive_path.stat().st_size
    archive_checksum = sha256_file(archive_path)
    if archive_checksum != expected_checksum:
        raise ValueError(f"Archive checksum mismatch: {archive_path.name}")
    report = ArchiveReport(
        archive=archive_path.name,
        symbol=symbol,
        day=day.isoformat(),
        archive_sha256=archive_checksum,
        expected_sha256=expected_checksum,
        member=member_name,
        archive_bytes=archive_bytes,
        checksum_name=checksum_path.name,
        checksum_bytes=checksum_bytes,
        checksum_sha256=checksum_sha256,
    )
    bucket_seconds = options.timeframe_minutes * 60
    offsets = tuple(decision_offsets(options.signal_type, bucket_seconds, options))
    candles: list[Candle] = []
    current: Candle | None = None
    current_partials: dict[int, Candle] = {}
    next_offset_index = 0
    current_last_id = ""
    previous_key: tuple[datetime, int | str] | None = None
    previous_numeric_id = int(previous_day_last_id) if previous_day_last_id is not None else None
    first_accepted_id: str | None = None
    missing_ranges: list[str] = []

    def snapshot_due_partials(until: datetime, *, complete: bool) -> None:
        nonlocal next_offset_index
        if current is None:
            return
        while next_offset_index < len(offsets):
            offset = offsets[next_offset_index]
            cutoff = current.start + timedelta(seconds=offset)
            if not complete and cutoff > until:
                break
            if complete or cutoff <= until:
                current_partials[offset] = copy_candle(current)
                next_offset_index += 1

    def finish_current() -> None:
        nonlocal current, current_partials, next_offset_index
        if current is None:
            return
        snapshot_due_partials(current.end, complete=True)
        setattr(current, "_partials", current_partials)
        setattr(current, "_last_trade_id", current_last_id)
        candles.append(current)
        current = None
        current_partials = {}
        next_offset_index = 0
    with zipfile.ZipFile(archive_path) as archive, archive.open(member_name) as raw:
        text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
        reader = csv.reader(text)
        first = next(reader, None)
        if first is None:
            raise ValueError(f"Trade CSV is empty: {archive_path.name}")
        source_rows: Iterable[list[str]] = reader if looks_like_header(first) else _prepend(first, reader)
        for raw_row in source_rows:
            trade = parse_trade_row(raw_row, archive_path.name, expected_day=day)
            if trade is None:
                report.rejected_trade_count += 1
                raise ValueError(
                    f"Invalid trade row quarantines official archive {archive_path.name}; "
                    f"rejected row {report.rejected_trade_count}"
                )
            key = trade_sort_key(trade)
            if previous_key is None and previous_day_last_event is not None and trade.event_time < previous_day_last_event:
                raise ValueError(f"Cross-archive event time regressed: {archive_path.name}")
            if previous_key is not None and key < previous_key:
                report.out_of_order_trade_count += 1
                raise ValueError(f"Out-of-order trades require quarantine: {archive_path.name}")
            previous_key = key
            numeric_id = int(trade.trade_id)
            if previous_numeric_id is not None and numeric_id <= previous_numeric_id:
                if numeric_id == previous_numeric_id:
                    report.duplicate_trade_count += 1
                    continue
                raise ValueError(f"Trade ID regressed in {archive_path.name}: {trade.trade_id}")
            if previous_numeric_id is not None and numeric_id != previous_numeric_id + 1:
                first_missing = previous_numeric_id + 1
                last_missing = numeric_id - 1
                report.missing_trade_id_count += last_missing - first_missing + 1
                missing_ranges.append(f"{first_missing}-{last_missing}")
            previous_numeric_id = numeric_id
            if trade.trade_id == previous_day_last_id:
                report.duplicate_trade_count += 1
                continue
            report.accepted_trade_count += 1
            if first_accepted_id is None:
                first_accepted_id = trade.trade_id
            if report.first_event_at is None:
                report.first_event_at = format_timestamp(trade.event_time)
            report.last_event_at = format_timestamp(trade.event_time)
            timestamp = int(trade.event_time.timestamp())
            start = datetime.fromtimestamp(timestamp - timestamp % bucket_seconds, tz=UTC)
            if current is None or start != current.start:
                if current is not None:
                    finish_current()
                current = candle_from_trades(
                    start, start + timedelta(seconds=bucket_seconds), (trade,)
                )
                while (
                    next_offset_index < len(offsets)
                    and current.start + timedelta(seconds=offsets[next_offset_index])
                    <= trade.event_time
                ):
                    next_offset_index += 1
            else:
                snapshot_due_partials(trade.event_time, complete=False)
                current.high = max(current.high, trade.price)
                current.low = min(current.low, trade.price)
                current.close = trade.price
                current.volume += trade.quantity
                current.buy_volume += 0.0 if trade.is_buyer_maker else trade.quantity
                current.sell_volume += trade.quantity if trade.is_buyer_maker else 0.0
                current.trade_count += 1
            current_last_id = trade.trade_id
    finish_current()
    if (
        archive_path.stat().st_size != archive_bytes
        or sha256_file(archive_path) != archive_checksum
    ):
        raise ValueError(f"Archive changed while being read: {archive_path.name}")
    if not candles:
        raise ValueError(f"Archive contains no accepted trades: {archive_path.name}")
    report.first_trade_id = first_accepted_id
    report.last_trade_id = current_last_id
    report.missing_trade_id_ranges = missing_ranges
    return report, candles


def collect_daily_archives(
    *,
    symbol: str,
    start: date,
    end: date,
    raw_root: Path,
    base_url: str,
    overwrite: bool,
    max_files: int,
) -> list[Path]:
    symbol = validate_symbol(symbol)
    if end <= start:
        raise ValueError("end must be later than start")
    if end > datetime.now(tz=UTC).date():
        raise ValueError("end is exclusive and cannot include the current or a future UTC day")
    parsed_base = urllib.parse.urlparse(base_url)
    if (
        parsed_base.scheme != "https"
        or parsed_base.hostname != "data.binance.vision"
        or parsed_base.username is not None
        or parsed_base.password is not None
        or parsed_base.port not in (None, 443)
        or parsed_base.path not in ("", "/")
        or parsed_base.query
        or parsed_base.fragment
    ):
        raise ValueError("Archive acquisition requires the canonical HTTPS data.binance.vision root")
    requested_days = (end - start).days
    if max_files < 1 or requested_days > max_files:
        raise ValueError(f"requested {requested_days} files, exceeding --max-files={max_files}")
    archive_root = raw_root / "archives"
    archive_root.mkdir(parents=True, exist_ok=True)
    results: list[Path] = []
    for offset in range(requested_days):
        day = start + timedelta(days=offset)
        filename = f"{symbol}-trades-{day.isoformat()}.zip"
        key = f"data/spot/daily/trades/{symbol}/{filename}"
        target = archive_root / filename
        checksum_target = target.with_suffix(target.suffix + ".CHECKSUM")
        if overwrite or not target.exists():
            try:
                download_atomic(join_url(base_url, key), target)
            except urllib.error.HTTPError as error:
                if error.code in {403, 404}:
                    raise RuntimeError(f"Binance archive is unavailable for {day}") from error
                raise
        if overwrite or not checksum_target.exists():
            try:
                download_atomic(join_url(base_url, f"{key}.CHECKSUM"), checksum_target)
            except urllib.error.HTTPError as error:
                if error.code in {403, 404}:
                    raise RuntimeError(f"Binance checksum is unavailable for {day}") from error
                raise
        expected = parse_checksum_file(checksum_target, filename)
        observed = sha256_file(target)
        if observed != expected:
            raise ValueError(f"Archive checksum mismatch: {filename}")
        validate_archive_identity(target, symbol, day)
        results.append(target)
    return results


def download_atomic(url: str, target: Path) -> None:
    validate_binance_data_vision_url(url, "requested download URL")
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=target.parent, suffix=".part", delete=False) as handle:
        temporary = Path(handle.name)
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "Flippars-data-collector/0.2"})
        with urllib.request.urlopen(request, timeout=120) as response, temporary.open("wb") as output:
            validate_binance_data_vision_url(response.geturl(), "final download URL")
            shutil.copyfileobj(response, output)
        if temporary.stat().st_size == 0:
            raise ValueError(f"Downloaded empty response: {url}")
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def validate_binance_data_vision_url(url: str, label: str) -> None:
    parsed = urllib.parse.urlparse(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "data.binance.vision"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in (None, 443)
        or parsed.fragment
    ):
        raise ValueError(f"{label} must remain on HTTPS data.binance.vision")


def parse_checksum_file(path: Path, expected_name: str) -> str:
    expected, _, _ = read_checksum_snapshot(path, expected_name)
    return expected


def read_checksum_snapshot(path: Path, expected_name: str) -> tuple[str, int, str]:
    with path.open("rb") as handle:
        payload = handle.read(MAX_CHECKSUM_BYTES + 1)
    size = len(payload)
    if size < 1 or size > MAX_CHECKSUM_BYTES:
        raise ValueError(f"Checksum file size is invalid: {path.name}")
    if any(byte < 0x20 and byte not in (0x0A, 0x0D) for byte in payload):
        raise ValueError(f"Checksum file contains a control character: {path.name}")
    try:
        text = payload.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ValueError(f"Checksum file must be UTF-8: {path.name}") from error
    lines = text.splitlines()
    if len(lines) != 1 or not lines[0].strip():
        raise ValueError(f"Checksum file must contain exactly one nonempty line: {path.name}")
    match = CHECKSUM_PATTERN.fullmatch(lines[0].strip())
    if not match or match.group("name") != expected_name:
        raise ValueError(f"Checksum file does not name the expected archive: {expected_name}")
    return (
        match.group("digest").lower(),
        size,
        hashlib.sha256(payload).hexdigest(),
    )


def validate_archive_identity(path: Path, symbol: str, day: date) -> str:
    match = ARCHIVE_PATTERN.fullmatch(path.name)
    if not match or match.group("symbol") != symbol or match.group("day") != day.isoformat():
        raise ValueError(f"Archive filename does not match requested symbol/date: {path.name}")
    with zipfile.ZipFile(path) as archive:
        members = [member for member in archive.infolist() if not member.is_dir()]
        if len(members) != 1:
            raise ValueError(f"Archive must contain exactly one trade CSV: {path.name}")
        member = members[0]
        expected_member = path.with_suffix(".csv").name
        if Path(member.filename).name != expected_member or Path(member.filename).name != member.filename:
            raise ValueError(f"Unexpected or unsafe archive member: {member.filename}")
        if member.file_size <= 0 or member.file_size > MAX_ARCHIVE_MEMBER_BYTES:
            raise ValueError(f"Archive member size is invalid: {member.filename}")
        return member.filename


def normalize_archive(archive_path: Path, normalized_root: Path) -> ArchiveReport:
    match = ARCHIVE_PATTERN.fullmatch(archive_path.name)
    if not match:
        raise ValueError(f"Unsupported archive filename: {archive_path.name}")
    symbol = validate_symbol(match.group("symbol"))
    day = date.fromisoformat(match.group("day"))
    member_name = validate_archive_identity(archive_path, symbol, day)
    checksum_path = archive_path.with_suffix(archive_path.suffix + ".CHECKSUM")
    if not checksum_path.exists():
        raise FileNotFoundError(f"Required checksum sidecar is missing: {checksum_path}")
    expected_checksum, checksum_bytes, checksum_sha256 = read_checksum_snapshot(
        checksum_path, archive_path.name
    )
    archive_bytes = archive_path.stat().st_size
    archive_checksum = sha256_file(archive_path)
    if archive_checksum != expected_checksum:
        raise ValueError(f"Archive checksum mismatch: {archive_path.name}")

    report = ArchiveReport(
        archive=archive_path.name,
        symbol=symbol,
        day=day.isoformat(),
        archive_sha256=archive_checksum,
        expected_sha256=expected_checksum,
        member=member_name,
        archive_bytes=archive_bytes,
        checksum_name=checksum_path.name,
        checksum_bytes=checksum_bytes,
        checksum_sha256=checksum_sha256,
    )
    trades: list[Trade] = []
    with zipfile.ZipFile(archive_path) as archive, archive.open(member_name) as raw:
        text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
        reader = csv.reader(text)
        first = next(reader, None)
        if first is None:
            raise ValueError(f"Trade CSV is empty: {archive_path.name}")
        rows: Iterable[list[str]] = reader if looks_like_header(first) else _prepend(first, reader)
        last_seen_key: tuple[datetime, int | str] | None = None
        for row in rows:
            trade = parse_trade_row(row, archive_path.name, expected_day=day)
            if trade is None:
                report.rejected_trade_count += 1
                continue
            key = trade_sort_key(trade)
            if last_seen_key is not None and key < last_seen_key:
                report.out_of_order_trade_count += 1
            last_seen_key = key
            trades.append(trade)

    if (
        archive_path.stat().st_size != archive_bytes
        or sha256_file(archive_path) != archive_checksum
    ):
        raise ValueError(f"Archive changed while being read: {archive_path.name}")
    trades.sort(key=trade_sort_key)
    unique: list[Trade] = []
    seen_ids: dict[str, Trade] = {}
    for trade in trades:
        previous = seen_ids.get(trade.trade_id)
        if previous is not None:
            if trade_payload(previous) != trade_payload(trade):
                raise ValueError(f"Conflicting duplicate trade ID {trade.trade_id} in {archive_path.name}")
            report.duplicate_trade_count += 1
            continue
        seen_ids[trade.trade_id] = trade
        unique.append(trade)
    if not unique:
        raise ValueError(f"Archive contains no valid trades: {archive_path.name}")
    report.accepted_trade_count = len(unique)
    report.first_event_at = format_timestamp(unique[0].event_time)
    report.last_event_at = format_timestamp(unique[-1].event_time)
    report.first_trade_id = unique[0].trade_id
    report.last_trade_id = unique[-1].trade_id
    previous_trade_id: int | None = None
    missing_ranges: list[str] = []
    for trade in unique:
        trade_id = int(trade.trade_id)
        if previous_trade_id is not None:
            if trade_id <= previous_trade_id:
                raise ValueError(
                    f"Trade ID regressed in normalized archive {archive_path.name}"
                )
            if trade_id != previous_trade_id + 1:
                first_missing = previous_trade_id + 1
                last_missing = trade_id - 1
                report.missing_trade_id_count += last_missing - first_missing + 1
                missing_ranges.append(f"{first_missing}-{last_missing}")
        previous_trade_id = trade_id
    report.missing_trade_id_ranges = missing_ranges

    normalized_root.mkdir(parents=True, exist_ok=True)
    target = normalized_root / f"{archive_path.stem}.csv"
    report_target = normalized_root / f"{archive_path.stem}.report.json"
    temporary = target.with_suffix(".csv.part")
    with temporary.open("w", newline="", encoding="utf-8") as output:
        writer = csv.writer(output, lineterminator="\n")
        writer.writerow(NORMALIZED_HEADER)
        for trade in unique:
            writer.writerow(
                (
                    format_trade_timestamp(trade.event_time),
                    trade.trade_id,
                    str(trade.price),
                    str(trade.quantity),
                    str(trade.quote_quantity),
                    "true" if trade.is_buyer_maker else "false",
                    trade.source_file,
                )
            )
    temporary.replace(target)
    report.normalized_file = target.name
    report.normalized_sha256 = sha256_file(target)
    write_json_atomic(report_target, asdict(report), overwrite=True)
    return report


def _prepend(first: list[str], rows: Iterable[list[str]]) -> Iterator[list[str]]:
    yield first
    yield from rows


def looks_like_header(row: Sequence[str]) -> bool:
    normalized = {cell.strip().lower().replace(" ", "_") for cell in row}
    return "price" in normalized and ("time" in normalized or "timestamp" in normalized)


def parse_trade_row(
    row: Sequence[str], source_file: str, *, expected_day: date | None = None
) -> Trade | None:
    if len(row) < 6:
        return None
    try:
        if looks_like_header(row):
            return None
        values = [cell.strip() for cell in row]
        if len(values) >= 7 and _looks_like_timestamp(values[4]):
            trade_id, price, quantity, quote_quantity, timestamp, maker = values[:6]
        elif len(values) >= 7 and _looks_like_timestamp(values[5]):
            trade_id, price, quantity, _first, _last, timestamp, maker = values[:7]
            quote_quantity = str(float(price) * float(quantity))
        else:
            return None
        if not trade_id or not re.fullmatch(r"[0-9]+", trade_id):
            return None
        expected_timestamp_unit = (
            "MICROSECOND"
            if expected_day is not None and expected_day >= date(2025, 1, 1)
            else "MILLISECOND"
            if expected_day is not None
            else None
        )
        event_time = parse_binance_epoch_timestamp(
            timestamp, expected_unit=expected_timestamp_unit
        )
        if expected_day is not None and event_time.date() != expected_day:
            return None
        price_value = float(price)
        quantity_value = float(quantity)
        quote_value = float(quote_quantity)
        if not (
            math.isfinite(price_value)
            and price_value > 0
            and math.isfinite(quantity_value)
            and quantity_value > 0
            and math.isfinite(quote_value)
            and quote_value > 0
        ):
            return None
        maker_value = maker.lower()
        if maker_value not in {"true", "false", "1", "0"}:
            return None
        return Trade(
            event_time=event_time,
            trade_id=trade_id,
            price=price_value,
            quantity=quantity_value,
            quote_quantity=quote_value,
            is_buyer_maker=maker_value in {"true", "1"},
            source_file=source_file,
        )
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def _looks_like_timestamp(value: str) -> bool:
    try:
        parse_binance_epoch_timestamp(value)
        return True
    except (ValueError, OverflowError, OSError):
        return False


def parse_binance_epoch_timestamp(
    value: str, *, expected_unit: str | None = None
) -> datetime:
    """Parse Binance's documented millisecond or microsecond integer epochs exactly."""
    if not re.fullmatch(r"[0-9]+", value):
        raise ValueError("Binance event time must be an unsigned integer epoch")
    epoch = int(value)
    if 1_000_000_000_000 <= epoch < 10_000_000_000_000:
        observed_unit = "MILLISECOND"
        divisor = 1_000
        micros_per_remainder = 1_000
    elif 1_000_000_000_000_000 <= epoch < 10_000_000_000_000_000:
        observed_unit = "MICROSECOND"
        divisor = 1_000_000
        micros_per_remainder = 1
    else:
        raise ValueError("Binance event time must use an unambiguous millisecond or microsecond epoch")
    if expected_unit is not None and observed_unit != expected_unit:
        raise ValueError(
            f"Binance Spot archive date requires {expected_unit.lower()} timestamps"
        )
    seconds, remainder = divmod(epoch, divisor)
    return datetime.fromtimestamp(seconds, tz=UTC) + timedelta(
        microseconds=remainder * micros_per_remainder
    )


def read_normalized_trades(normalized_path: Path) -> Iterator[Trade]:
    with normalized_path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        if tuple(reader.fieldnames or ()) != NORMALIZED_HEADER:
            raise ValueError(f"Unexpected normalized schema: {normalized_path}")
        for line_number, row in enumerate(reader, start=2):
            try:
                trade = Trade(
                    event_time=parse_timestamp(str(row["event_time_utc"])),
                    trade_id=str(row["trade_id"]),
                    price=float(row["price"]),
                    quantity=float(row["quantity"]),
                    quote_quantity=float(row["quote_quantity"]),
                    is_buyer_maker=parse_bool(str(row["is_buyer_maker"])),
                    source_file=str(row["source_file"]),
                )
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError(f"Invalid normalized trade at {normalized_path}:{line_number}") from error
            if not re.fullmatch(r"[0-9]+", trade.trade_id) or not all(
                math.isfinite(value) and value > 0
                for value in (trade.price, trade.quantity, trade.quote_quantity)
            ):
                raise ValueError(f"Invalid normalized trade at {normalized_path}:{line_number}")
            yield trade


def load_ordered_trades(normalized_root: Path) -> tuple[list[Trade], int]:
    paths = sorted(normalized_root.glob("*-trades-????-??-??.csv"))
    if not paths:
        raise ValueError(f"No normalized trade CSVs found under {normalized_root}")
    trades = [trade for path in paths for trade in read_normalized_trades(path)]
    trades.sort(key=trade_sort_key)
    result: list[Trade] = []
    seen: dict[str, Trade] = {}
    duplicate_count = 0
    for trade in trades:
        previous = seen.get(trade.trade_id)
        if previous is not None:
            if trade_payload(previous) != trade_payload(trade):
                raise ValueError(f"Conflicting duplicate trade ID across normalized files: {trade.trade_id}")
            duplicate_count += 1
            continue
        seen[trade.trade_id] = trade
        result.append(trade)
    return result, duplicate_count


def prepare_dataset(
    *,
    normalized_root: Path,
    output: Path,
    manifest_output: Path,
    signal_type: str,
    deadband_bps: float,
    timeframe_minutes: int | None,
    decision_cadence_seconds: int,
    minimum_lead_time_seconds: int | None,
    archive_reports: Sequence[ArchiveReport] | None = None,
    lineage_kind: str = "LOCAL_ARCHIVE_REPLAY",
) -> dict[str, object]:
    duration_seconds = SIGNAL_DURATION_SECONDS.get(signal_type)
    expected_minutes = (duration_seconds or 0) // 60
    if timeframe_minutes is None:
        timeframe_minutes = expected_minutes
    if minimum_lead_time_seconds is None:
        minimum_lead_time_seconds = SIGNAL_MINIMUM_LEAD_TIME_SECONDS[signal_type]
    options = DatasetOptions(
        signal_type=signal_type,
        deadband_bps=deadband_bps,
        timeframe_minutes=timeframe_minutes,
        decision_cadence_seconds=decision_cadence_seconds,
        minimum_lead_time_seconds=minimum_lead_time_seconds,
    )
    validate_dataset_options(options)
    trades, cross_file_duplicates = load_ordered_trades(normalized_root)
    rows, gap_starts = examples_from_trades(trades, options)
    if gap_starts:
        raise ValueError(
            f"Detected {len(gap_starts)} missing aligned candle windows; quarantine and repair source coverage"
        )
    minimum_rows = 60
    if len(rows) < minimum_rows:
        raise ValueError(f"At least {minimum_rows} prepared rows are required; found {len(rows)}")
    if len({str(row["id"]) for row in rows}) != len(rows):
        raise ValueError("Prepared row IDs must be unique")
    reports = list(archive_reports or load_archive_reports(normalized_root))
    validate_normalized_reports(normalized_root, reports)
    return write_prepared_dataset(
        rows=rows,
        trades_accepted=len(trades),
        cross_file_duplicates=cross_file_duplicates,
        reports=reports,
        gap_starts=gap_starts,
        output=output,
        manifest_output=manifest_output,
        options=options,
        lineage_kind=lineage_kind,
    )


def write_prepared_dataset(
    *,
    rows: Iterable[dict[str, object]],
    trades_accepted: int | None,
    cross_file_duplicates: int,
    reports: Sequence[ArchiveReport],
    gap_starts: Sequence[datetime],
    output: Path,
    manifest_output: Path,
    options: DatasetOptions,
    lineage_kind: str = "SYNTHETIC_LOCAL",
    acquisition_manifest_path: Path | None = None,
) -> dict[str, object]:
    row_count = 0
    window_count = 0
    first_decision_at: str | None = None
    last_window_end: str | None = None
    previous_key: tuple[str, str] | None = None
    previous_window: str | None = None
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest_output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise FileExistsError(f"Refusing to overwrite prepared dataset: {output}")
    if manifest_output.exists():
        raise FileExistsError(f"Refusing to overwrite dataset manifest: {manifest_output}")
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            newline="\n",
            dir=output.parent,
            prefix=f".{output.name}.",
            suffix=".part",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            for row in rows:
                key = (str(row["decisionAt"]), str(row["id"]))
                if previous_key is not None and key <= previous_key:
                    raise ValueError("Prepared rows must have unique monotonic IDs")
                previous_key = key
                window = str(row["windowStart"])
                if previous_window is not None and window < previous_window:
                    raise ValueError("Prepared windows must be monotonic")
                if window != previous_window:
                    window_count += 1
                    previous_window = window
                first_decision_at = first_decision_at or key[0]
                last_window_end = str(row["windowEnd"])
                row_count += 1
                handle.write(canonical_json(row) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        if row_count < 60:
            raise ValueError(f"At least 60 prepared rows are required; found {row_count}")
        if output.exists():
            raise FileExistsError(f"Refusing to overwrite prepared dataset: {output}")
        temporary.rename(output)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    dataset_sha256 = sha256_file(output)
    accepted_count = (
        sum(report.accepted_trade_count for report in reports)
        if trades_accepted is None
        else trades_accepted
    )
    rejected_count = sum(report.rejected_trade_count for report in reports)
    duplicate_count = sum(report.duplicate_trade_count for report in reports) + cross_file_duplicates
    signal_type = options.signal_type
    deadband_bps = options.deadband_bps
    decision_cadence_seconds = options.decision_cadence_seconds
    minimum_lead_time_seconds = options.minimum_lead_time_seconds
    model_fit_end = int(window_count * 0.6)
    calibration_end = int(window_count * 0.8)
    partition_window_counts = {
        "modelFit": model_fit_end,
        "calibration": calibration_end - model_fit_end,
        "evaluation": window_count - calibration_end,
    }
    if lineage_kind not in {
        "PUBLIC_BINANCE_ARCHIVE",
        "LOCAL_ARCHIVE_REPLAY",
        "SYNTHETIC_LOCAL",
    }:
        output.unlink(missing_ok=True)
        raise ValueError("Unsupported dataset lineage kind")
    if lineage_kind == "PUBLIC_BINANCE_ARCHIVE" and acquisition_manifest_path is None:
        output.unlink(missing_ok=True)
        raise ValueError("Public Binance lineage requires acquisition evidence")
    if reports:
        report_days = [date.fromisoformat(report.day) for report in reports]
        if any(
            current != previous + timedelta(days=1)
            for previous, current in zip(report_days, report_days[1:])
        ):
            output.unlink(missing_ok=True)
            raise ValueError("Dataset reports do not form a contiguous UTC date range")
        source_start_date: str | None = report_days[0].isoformat()
        source_end_date: str | None = (report_days[-1] + timedelta(days=1)).isoformat()
    else:
        source_start_date = None
        source_end_date = None
    acquisition_evidence: dict[str, object] | None = None
    try:
        if acquisition_manifest_path is not None:
            acquisition_evidence = validate_acquisition_evidence(
                acquisition_manifest_path,
                reports,
                source_start_date,
                source_end_date,
            )
    except BaseException:
        output.unlink(missing_ok=True)
        raise
    manifest = {
        "schemaVersion": DATASET_MANIFEST_SCHEMA_VERSION,
        "datasetSchemaVersion": DATASET_SCHEMA_VERSION,
        "createdAt": format_timestamp(datetime.now(tz=UTC)),
        "symbol": SUPPORTED_SYMBOL,
        "source": {
            "lineageKind": lineage_kind,
            "venue": "BINANCE",
            "marketType": "SPOT",
            "input": "TRADE",
            "timeBasis": "EVENT_TIME",
            "startDateInclusive": source_start_date,
            "endDateExclusive": source_end_date,
            "dayCount": len(reports),
            "acquisitionEvidence": acquisition_evidence,
            "archives": [asdict(report) for report in reports],
        },
        "target": target_contract_for_options(options),
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "featureNames": list(FEATURE_NAMES),
        "sampling": {
            "decisionPolicyVersion": DECISION_POLICY_VERSION,
            "decisionCadenceSeconds": decision_cadence_seconds,
            "minimumLeadTimeSeconds": minimum_lead_time_seconds,
            "featureCutoff": "EVENT_TIME_LT_DECISION_AT",
            "firstThresholdCrossingEvaluatedByReplay": True,
        },
        "guard": {
            "sourceIntegrityRequired": True,
            "crossVenueGuardAvailability": "UNAVAILABLE",
            "productionEligible": False,
        },
        "startAt": first_decision_at,
        "endAt": last_window_end,
        "acceptedTradeCount": accepted_count,
        "rejectedTradeCount": rejected_count,
        "gapCount": len(gap_starts),
        "gapWindowStarts": [format_timestamp(value) for value in gap_starts],
        "duplicateTradeCount": duplicate_count,
        "preparedDecisionRowCount": row_count,
        "preparedWindowCount": window_count,
        "windowCountUnit": "UNIQUE_WINDOW_START",
        "partitionWindowCounts": partition_window_counts,
        "preparedDatasetSha256": dataset_sha256,
        "options": asdict(options),
        "generator": runtime_metadata(),
    }
    try:
        validate_dataset_manifest(manifest)
        write_new_json(manifest_output, manifest)
    except BaseException:
        output.unlink(missing_ok=True)
        manifest_output.unlink(missing_ok=True)
        raise
    return {
        "rows": row_count,
        "output": str(output.resolve()),
        "manifest": str(manifest_output.resolve()),
        "datasetContentSha256": dataset_sha256,
        "gapCount": len(gap_starts),
        "rejectedTradeCount": rejected_count,
        "duplicateTradeCount": duplicate_count,
    }


def load_archive_reports(normalized_root: Path) -> list[ArchiveReport]:
    reports: list[ArchiveReport] = []
    for path in sorted(normalized_root.glob("*.report.json")):
        value = read_json_object(path)
        reports.append(ArchiveReport(**value))
    return reports


def validate_normalized_reports(
    normalized_root: Path, reports: Sequence[ArchiveReport]
) -> None:
    csv_paths = sorted(normalized_root.glob("*-trades-????-??-??.csv"))
    if not reports or len(reports) != len(csv_paths):
        raise ValueError("Every normalized CSV requires exactly one strict archive report")
    by_file = {report.normalized_file: report for report in reports}
    if len(by_file) != len(reports):
        raise ValueError("Normalized archive reports must identify unique files")
    for path in csv_paths:
        report = by_file.get(path.name)
        if report is None or report.symbol != SUPPORTED_SYMBOL:
            raise ValueError(f"Missing source report for {path.name}")
        if report.archive_sha256 != report.expected_sha256:
            raise ValueError(f"Source checksum was not verified for {path.name}")
        if not re.fullmatch(r"[a-f0-9]{64}", report.normalized_sha256):
            raise ValueError(f"Invalid normalized digest for {path.name}")
        if sha256_file(path) != report.normalized_sha256:
            raise ValueError(f"Normalized file changed after source validation: {path.name}")


def aggregate_candles(
    trades: Iterable[Trade], timeframe_minutes: int
) -> tuple[list[Candle], list[datetime]]:
    bucket_seconds = timeframe_minutes * 60
    buckets: dict[datetime, Candle] = {}
    for trade in trades:
        timestamp = int(trade.event_time.timestamp())
        start = datetime.fromtimestamp(timestamp - timestamp % bucket_seconds, tz=UTC)
        candle = buckets.get(start)
        if candle is None:
            candle = Candle(
                start=start,
                end=start + timedelta(seconds=bucket_seconds),
                open=trade.price,
                high=trade.price,
                low=trade.price,
                close=trade.price,
                volume=trade.quantity,
                buy_volume=0.0 if trade.is_buyer_maker else trade.quantity,
                sell_volume=trade.quantity if trade.is_buyer_maker else 0.0,
                trade_count=1,
            )
            buckets[start] = candle
            continue
        candle.high = max(candle.high, trade.price)
        candle.low = min(candle.low, trade.price)
        candle.close = trade.price
        candle.volume += trade.quantity
        candle.buy_volume += 0.0 if trade.is_buyer_maker else trade.quantity
        candle.sell_volume += trade.quantity if trade.is_buyer_maker else 0.0
        candle.trade_count += 1
    candles = [buckets[key] for key in sorted(buckets)]
    gaps: list[datetime] = []
    for previous, current in zip(candles, candles[1:]):
        cursor = previous.end
        while cursor < current.start:
            gaps.append(cursor)
            cursor += timedelta(seconds=bucket_seconds)
    return candles, gaps


def examples_from_candles(
    candles: Sequence[Candle], options: DatasetOptions
) -> Iterator[dict[str, object]]:
    duration_seconds = options.timeframe_minutes * 60
    for index in range(13, len(candles)):
        history = candles[index - 13:index]
        previous = history[-1]
        target = candles[index]
        if previous.end != target.start:
            continue
        if any(left.end != right.start for left, right in zip(history, history[1:])):
            continue
        target_open = target.open
        relation = close_relation(target.close, target_open, options.deadband_bps)
        for elapsed_seconds in decision_offsets(options.signal_type, duration_seconds, options):
            decision_at = target.start + timedelta(seconds=elapsed_seconds)
            # Candle aggregates alone cannot reconstruct partial state.  The
            # public helper therefore emits only when point snapshots were
            # attached by examples_from_trades; this guard prevents leakage.
            partials = getattr(target, "_partials", None)
            if not isinstance(partials, dict) or elapsed_seconds not in partials:
                continue
            partial = partials[elapsed_seconds]
            current_relation = close_relation(partial.close, target_open, options.deadband_bps)
            eligible = signal_candidate_eligible(options.signal_type, current_relation, elapsed_seconds)
            yield {
                "schemaVersion": DATASET_SCHEMA_VERSION,
                "id": f"{SUPPORTED_SYMBOL}:{format_timestamp(target.start)}:{options.signal_type}:{elapsed_seconds}",
                "signalType": options.signal_type,
                "decisionAt": format_timestamp(decision_at),
                "windowStart": format_timestamp(target.start),
                "windowEnd": format_timestamp(target.end),
                "durationSeconds": duration_seconds,
                "currentRelation": current_relation,
                "candidateEligible": eligible,
                "features": feature_map(
                    history, partial, target_open, elapsed_seconds, duration_seconds
                ),
                "label": relation,
                "deadbandBps": options.deadband_bps,
                "sourceIntegrityHealthy": True,
                "crossVenueGuardAvailability": "UNAVAILABLE",
                "productionEligible": False,
            }


def examples_from_trades(
    trades: Sequence[Trade], options: DatasetOptions
) -> tuple[list[dict[str, object]], list[datetime]]:
    duration_seconds = options.timeframe_minutes * 60
    candles, gaps = aggregate_candles(trades, options.timeframe_minutes)
    by_start: dict[datetime, list[Trade]] = {}
    for trade in trades:
        timestamp = int(trade.event_time.timestamp())
        start = datetime.fromtimestamp(timestamp - timestamp % duration_seconds, tz=UTC)
        by_start.setdefault(start, []).append(trade)
    for candle in candles:
        candle_trades = by_start[candle.start]
        partials: dict[int, Candle] = {}
        for offset in decision_offsets(options.signal_type, duration_seconds, options):
            cutoff = candle.start + timedelta(seconds=offset)
            observed = [trade for trade in candle_trades if trade.event_time < cutoff]
            if not observed:
                continue
            partials[offset] = candle_from_trades(candle.start, candle.end, observed)
        setattr(candle, "_partials", partials)
    return list(examples_from_candles(candles, options)), gaps


def decision_offsets(
    signal_type: str, duration_seconds: int, options: DatasetOptions
) -> range:
    first = options.decision_cadence_seconds
    stop = duration_seconds - options.minimum_lead_time_seconds
    if signal_type == "FIFTEEN_MINUTE_REVERSAL":
        first = 450
    elif signal_type == "FIVE_MINUTE_EARLY_DIRECTION":
        stop = min(stop, 59)
    if stop < first:
        return range(0)
    return range(first, stop + 1, options.decision_cadence_seconds)


def governed_decision_offsets(signal_type: str) -> tuple[int, ...]:
    duration_seconds = SIGNAL_DURATION_SECONDS[signal_type]
    governed_options = DatasetOptions(
        signal_type=signal_type,
        deadband_bps=DEFAULT_DEADBAND_BPS,
        timeframe_minutes=duration_seconds // 60,
        decision_cadence_seconds=DEFAULT_DECISION_CADENCE_SECONDS,
        minimum_lead_time_seconds=SIGNAL_MINIMUM_LEAD_TIME_SECONDS[signal_type],
    )
    return tuple(decision_offsets(signal_type, duration_seconds, governed_options))


def candle_from_trades(start: datetime, end: datetime, trades: Sequence[Trade]) -> Candle:
    first = trades[0]
    return Candle(
        start=start,
        end=end,
        open=first.price,
        high=max(trade.price for trade in trades),
        low=min(trade.price for trade in trades),
        close=trades[-1].price,
        volume=sum(trade.quantity for trade in trades),
        buy_volume=sum(trade.quantity for trade in trades if not trade.is_buyer_maker),
        sell_volume=sum(trade.quantity for trade in trades if trade.is_buyer_maker),
        trade_count=len(trades),
    )


def copy_candle(candle: Candle) -> Candle:
    return Candle(
        start=candle.start,
        end=candle.end,
        open=candle.open,
        high=candle.high,
        low=candle.low,
        close=candle.close,
        volume=candle.volume,
        buy_volume=candle.buy_volume,
        sell_volume=candle.sell_volume,
        trade_count=candle.trade_count,
    )


def feature_map(
    history: Sequence[Candle],
    current: Candle,
    current_open: float,
    elapsed_seconds: int,
    duration_seconds: int,
) -> dict[str, float]:
    previous = history[-1]
    last_twelve = history[-12:]
    returns = [return_bps(candle.close, candle.open) for candle in last_twelve]
    mean_volume = sum(candle.volume for candle in last_twelve) / 12
    mean_trades = sum(candle.trade_count for candle in last_twelve) / 12
    completed_volume_rate = mean_volume / duration_seconds
    completed_trade_rate = mean_trades / duration_seconds
    elapsed_denominator = max(elapsed_seconds, 1)
    current_volume_rate = current.volume / elapsed_denominator
    current_trade_rate = current.trade_count / elapsed_denominator
    values = {
        "previous_return_bps": return_bps(previous.close, previous.open),
        "previous_range_bps": range_bps(previous.high, previous.low, previous.open),
        "previous_volume_log1p": math.log1p(previous.volume),
        "previous_trade_count_log1p": math.log1p(previous.trade_count),
        "previous_buy_ratio": previous.buy_volume / previous.volume,
        "previous_close_location": close_location(previous.close, previous.high, previous.low),
        "current_return_from_open_bps": return_bps(current.close, current_open),
        "current_range_bps": range_bps(current.high, current.low, current_open),
        "current_volume_log1p": math.log1p(current.volume),
        "current_trade_count_log1p": math.log1p(current.trade_count),
        "current_buy_ratio": current.buy_volume / current.volume,
        "current_close_location": close_location(current.close, current.high, current.low),
        "elapsed_ratio": elapsed_seconds / duration_seconds,
        "remaining_ratio": (duration_seconds - elapsed_seconds) / duration_seconds,
        "return_3_candle_bps": return_bps(previous.close, history[-4].close),
        "return_12_candle_bps": return_bps(previous.close, history[-13].close),
        "realized_volatility_12": float(np.std(np.asarray(returns, dtype=float))),
        "mean_range_12_bps": sum(
            range_bps(candle.high, candle.low, candle.open) for candle in last_twelve
        ) / 12,
        "previous_volume_relative_12": previous.volume / max(mean_volume, 1e-12),
        "previous_trade_count_relative_12": previous.trade_count / max(mean_trades, 1e-12),
        "current_volume_rate_log1p": math.log1p(current_volume_rate),
        "current_trade_rate_log1p": math.log1p(current_trade_rate),
        "current_volume_rate_relative_12": current_volume_rate / max(completed_volume_rate, 1e-12),
        "current_trade_rate_relative_12": current_trade_rate / max(completed_trade_rate, 1e-12),
    }
    if tuple(values) != FEATURE_NAMES or not all(math.isfinite(value) for value in values.values()):
        raise ValueError("Feature generation produced an invalid schema or non-finite value")
    return values


def signal_candidate_eligible(signal_type: str, current_relation: str, elapsed_seconds: int) -> bool:
    if signal_type == "FIVE_MINUTE_EARLY_DIRECTION":
        return elapsed_seconds < 60
    if signal_type == "FIFTEEN_MINUTE_REVERSAL" and elapsed_seconds < 450:
        return False
    return current_relation != "AT_OPEN"


def close_relation(
    close: float | Decimal, open_price: float | Decimal, deadband_bps: float
) -> str:
    close_decimal = close if isinstance(close, Decimal) else Decimal(str(close))
    open_decimal = (
        open_price if isinstance(open_price, Decimal) else Decimal(str(open_price))
    )
    deadband_decimal = Decimal(str(deadband_bps))
    scaled_change = (close_decimal - open_decimal) * Decimal(10_000)
    threshold = open_decimal * deadband_decimal
    if scaled_change > threshold:
        return "ABOVE_OPEN"
    if scaled_change < -threshold:
        return "BELOW_OPEN"
    return "AT_OPEN"


def relation_from_return_bps(value: float | Decimal, deadband_bps: float) -> str:
    value_decimal = value if isinstance(value, Decimal) else Decimal(str(value))
    deadband_decimal = Decimal(str(deadband_bps))
    if value_decimal > deadband_decimal:
        return "ABOVE_OPEN"
    if value_decimal < -deadband_decimal:
        return "BELOW_OPEN"
    return "AT_OPEN"


def train_draft(
    *,
    input_path: Path,
    manifest_path: Path,
    output_path: Path,
    evaluation_path: Path,
    signal_type: str,
    version: str,
    deadband_bps: float,
    confidence_threshold: float,
    validity_days: int,
) -> dict[str, object]:
    validate_train_options(signal_type, version, deadband_bps, confidence_threshold, validity_days)
    manifest_value, manifest_sha256 = read_json_object_and_sha256(manifest_path)
    manifest = validate_dataset_manifest(manifest_value)
    target = manifest["target"]
    if target["signalType"] != signal_type:
        raise ValueError("Requested signal type does not match dataset manifest")
    if float(target["deadbandBps"]) != deadband_bps:
        raise ValueError("Requested deadband does not match dataset manifest")
    expected_target = target_contract_for_options(
        DatasetOptions(
            signal_type=signal_type,
            deadband_bps=deadband_bps,
            timeframe_minutes=SIGNAL_DURATION_SECONDS[signal_type] // 60,
            decision_cadence_seconds=int(manifest["sampling"]["decisionCadenceSeconds"]),
            minimum_lead_time_seconds=int(manifest["sampling"]["minimumLeadTimeSeconds"]),
        )
    )
    if target != expected_target:
        raise ValueError("Dataset manifest target/schedule is not the governed contract")

    manifest_gap_starts = [
        parse_timestamp(str(value)) for value in manifest["gapWindowStarts"]
    ]
    poisoned_window_starts = gap_poisoned_window_starts(
        manifest_gap_starts,
        duration_seconds=SIGNAL_DURATION_SECONDS[signal_type],
    )
    train_rows, calibration_rows, holdout_rows, sampling = load_training_partitions(
        input_path,
        signal_type,
        deadband_bps,
        forbidden_window_starts=poisoned_window_starts,
    )
    corpus_audit = sampling["corpusPassAudit"]
    if not isinstance(corpus_audit, dict) or corpus_audit.get("passesMatched") is not True:
        raise ValueError("Training corpus pass audit is incomplete")
    dataset_sha256 = str(corpus_audit["sha256"])
    if manifest["preparedDatasetSha256"] != dataset_sha256:
        raise ValueError("Prepared dataset SHA-256 does not match its validated corpus bytes")
    if int(corpus_audit["decisionRowCount"]) != int(manifest["preparedDecisionRowCount"]):
        raise ValueError("Prepared dataset row count does not match its manifest")
    if int(corpus_audit["windowCount"]) != int(manifest["preparedWindowCount"]):
        raise ValueError("Prepared dataset window count does not match its manifest")
    if corpus_audit["firstDecisionAt"] != manifest["startAt"]:
        raise ValueError("Prepared dataset start does not match its manifest")
    if corpus_audit["lastWindowEnd"] != manifest["endAt"]:
        raise ValueError("Prepared dataset end does not match its manifest")
    feature_names = list(FEATURE_NAMES)
    partition_window_counts = sampling["corpusPartitionWindowCounts"]
    if sum(partition_window_counts.values()) != int(manifest["preparedWindowCount"]):
        raise ValueError("Partition independent-window counts do not cover the dataset exactly")
    if manifest.get("partitionWindowCounts") != partition_window_counts:
        raise ValueError("Dataset manifest partition-window counts do not match deterministic split")
    normalization = fit_normalization(train_rows, feature_names)
    train_x = feature_matrix(train_rows, feature_names, *normalization)
    calibration_x = feature_matrix(calibration_rows, feature_names, *normalization)
    train_y = labels(train_rows)
    calibration_y = labels(calibration_rows)
    require_class_support(train_y, "training")
    require_class_support(calibration_y, "calibration")
    require_class_window_support(train_rows, "training")
    require_class_window_support(calibration_rows, "calibration")

    train_sample_weights = window_balanced_weights(train_rows)
    calibration_sample_weights = window_balanced_weights(calibration_rows)
    weights, biases, fit_diagnostics = fit_multinomial(
        train_x, train_y, train_sample_weights
    )
    calibration_logits = calibration_x @ weights.T + biases
    temperature = fit_temperature(
        calibration_logits, calibration_y, calibration_sample_weights
    )
    calibration_probabilities = softmax(calibration_logits / temperature)
    ood = fit_ood_envelope(
        train_rows,
        feature_names,
        normalization[0],
        normalization[1],
        str(sampling["partitionEnds"]["train"]),
    )
    selected_baseline_kind, calibration_baselines = select_baseline_on_calibration(
        train_rows,
        train_y,
        calibration_rows,
        calibration_y,
    )
    pre_evaluation_policy = build_pre_evaluation_policy(
        signal_type=signal_type,
        target=target,
        feature_names=feature_names,
        normalization=normalization,
        weights=weights,
        biases=biases,
        temperature=temperature,
        ood=ood,
        fit_diagnostics=fit_diagnostics,
        sampling=sampling,
        selected_baseline_kind=selected_baseline_kind,
        confidence_threshold=confidence_threshold,
        deadband_bps=deadband_bps,
    )
    pre_evaluation_policy_sha256 = policy_digest(pre_evaluation_policy)

    holdout_x = feature_matrix(holdout_rows, feature_names, *normalization)
    holdout_y = labels(holdout_rows)
    holdout_sample_weights = window_balanced_weights(holdout_rows)
    holdout_probabilities = softmax((holdout_x @ weights.T + biases) / temperature)
    evaluation_sampling = {
        **sampling,
        "sampledClassWindowCounts": {
            **sampling["sampledClassWindowCounts"],
            "holdout": sampled_class_window_counts(holdout_rows),
        },
    }
    evaluation = evaluate_probabilities(holdout_probabilities, holdout_y)
    window_balanced_evaluation = evaluate_probabilities(
        holdout_probabilities, holdout_y, holdout_sample_weights
    )
    window_balanced_evaluation["dependenceAwareUncertainty"] = time_block_metric_intervals(
        holdout_rows, holdout_probabilities, holdout_y
    )
    holdout_baselines = {
        "GLOBAL_TRAIN_CLASS_FREQUENCY": global_frequency_baseline(train_y, holdout_y),
        "TRAIN_CURRENT_RELATION_PHASE_FREQUENCY": conditional_baseline(
            train_rows, holdout_rows, holdout_y
        ),
    }
    selected_holdout_baseline = holdout_baselines[selected_baseline_kind]
    in_distribution_indices = [
        index
        for index, row in enumerate(holdout_rows)
        if row_abstention_reason(
            row,
            feature_names,
            ood,
            require_cross_venue_guard=False,
        )
        is None
    ]
    in_distribution_report = calibration_population_report(
        holdout_rows,
        holdout_probabilities,
        holdout_y,
        in_distribution_indices,
        population="IN_DISTRIBUTION_BINANCE_SCHEDULED_ROWS",
        minimum_windows=100,
    )
    if in_distribution_indices:
        selected_rows = [holdout_rows[index] for index in in_distribution_indices]
        in_distribution_report["dependenceAwareUncertainty"] = time_block_metric_intervals(
            selected_rows,
            holdout_probabilities[np.asarray(in_distribution_indices, dtype=int)],
            holdout_y[np.asarray(in_distribution_indices, dtype=int)],
        )
    conditional_policy = replay_policy(
        holdout_rows,
        holdout_probabilities,
        confidence_threshold,
        feature_names=feature_names,
        ood_envelope=ood,
        require_cross_venue_guard=False,
        scope="BINANCE_CONDITIONAL_DIAGNOSTIC",
    )
    production_policy = replay_policy(
        holdout_rows,
        holdout_probabilities,
        confidence_threshold,
        feature_names=feature_names,
        ood_envelope=ood,
        require_cross_venue_guard=True,
        scope="PRODUCTION_GUARDED_REPLAY",
    )
    direction_eligible_indices = [
        index
        for index in in_distribution_indices
        if direction_eligible(holdout_rows[index], holdout_probabilities[index])[0]
    ]
    calibration_populations = {
        "allScheduled": calibration_population_report(
            holdout_rows,
            holdout_probabilities,
            holdout_y,
            list(range(len(holdout_rows))),
            population="ALL_SCHEDULED_ROWS",
            minimum_windows=100,
        ),
        "directionEligible": calibration_population_report(
            holdout_rows,
            holdout_probabilities,
            holdout_y,
            direction_eligible_indices,
            population="OOD_HEALTHY_DIRECTION_ELIGIBLE_BINANCE_CONDITIONAL_ROWS",
            minimum_windows=100,
        ),
        "firstEmitted": calibration_population_report(
            holdout_rows,
            holdout_probabilities,
            holdout_y,
            list(conditional_policy["emittedRowIndices"]),
            population="FIRST_EMITTED_BINANCE_CONDITIONAL_ALERTS",
            minimum_windows=100,
        ),
        "temperatureFitPopulation": "ALL_CALIBRATION_SCHEDULED_ROWS",
        "emittedSubsetCalibrationFit": False,
        "userFacingConfidenceCalibrationClaimSupported": False,
    }
    walk_forward = walk_forward_evaluation(
        train_rows + calibration_rows + holdout_rows
    )
    created_at = datetime.now(tz=UTC)
    artifact = {
        "schemaVersion": ARTIFACT_SCHEMA_VERSION,
        "artifactId": f"candidate:{signal_type}:{version}",
        "version": version,
        "status": "DRAFT",
        "signalType": signal_type,
        "target": target,
        "createdAt": format_timestamp(created_at),
        "modelFitThrough": sampling["partitionEnds"]["train"],
        "calibrationFitThrough": sampling["partitionEnds"]["calibration"],
        "evaluationThrough": sampling["partitionEnds"]["holdout"],
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "featureNames": feature_names,
        "normalization": {"means": normalization[0].tolist(), "scales": normalization[1].tolist()},
        "ood": ood,
        "model": {
            "kind": "MULTINOMIAL_LOGISTIC",
            "weights": weights.tolist(),
            "biases": biases.tolist(),
        },
        "calibration": {
            "method": "TEMPERATURE",
            "temperature": temperature,
            "version": "temperature.1",
            "validUntil": format_timestamp(created_at + timedelta(days=validity_days)),
        },
        "datasetContentSha256": dataset_sha256,
        "datasetManifestSha256": manifest_sha256,
        "datasetManifest": dataset_manifest_summary(
            manifest, dataset_sha256, manifest_sha256
        ),
        "preEvaluationPolicySha256": pre_evaluation_policy_sha256,
        "trainingCodeSha256": sha256_file(Path(__file__)),
        "approval": {"approvedAt": None, "approvedBy": None},
    }
    validate_candidate_artifact(artifact)
    evaluation_payload = {
        "schemaVersion": "flippars.model-evaluation/4",
        "status": "DRAFT",
        "productionEligible": False,
        "evaluationScope": "BINANCE_CONDITIONAL_DETERMINISTIC_WINDOW_SAMPLE_DIAGNOSTIC_ONLY",
        "artifactSchemaVersion": ARTIFACT_SCHEMA_VERSION,
        "signalType": signal_type,
        "version": version,
        "datasetSha256": dataset_sha256,
        "datasetManifestSha256": manifest_sha256,
        "thresholdPolicy": {
            "method": "PREDECLARED",
            "confidenceThreshold": confidence_threshold,
            "deadbandBps": deadband_bps,
            "decisionPolicyVersion": DECISION_POLICY_VERSION,
        },
        "partitions": partition_summary(train_rows, calibration_rows, holdout_rows),
        "sampling": evaluation_sampling,
        "preEvaluationPolicy": pre_evaluation_policy,
        "preEvaluationPolicySha256": pre_evaluation_policy_sha256,
        "fitDiagnostics": fit_diagnostics,
        "temperature": temperature,
        "calibration": evaluate_probabilities(calibration_probabilities, calibration_y),
        "calibrationWindowBalanced": evaluate_probabilities(
            calibration_probabilities, calibration_y, calibration_sample_weights
        ),
        "holdout": evaluation,
        "holdoutWindowBalanced": window_balanced_evaluation,
        "holdoutOutcomeSupport": outcome_support_report(holdout_rows),
        "inDistributionHoldout": in_distribution_report,
        "calibrationByDecisionPopulation": calibration_populations,
        "baselines": {
            "selectionPartition": "CALIBRATION",
            "selectionCandidates": calibration_baselines,
            "selectedKindBeforeEvaluation": selected_baseline_kind,
            "holdoutReports": holdout_baselines,
        },
        "brierSkillFraction": brier_skill(
            evaluation["brierScore"], selected_holdout_baseline["brierScore"]
        ),
        "holdoutPolicyReplay": conditional_policy,
        "productionGuardedPolicyReplay": production_policy,
        "walkForward": walk_forward,
        "challengers": challenger_scaffold(),
        "reproducibility": {
            **runtime_metadata(),
            "trainingCodeSha256": artifact["trainingCodeSha256"],
            "numpyVersion": np.__version__,
            "parameters": {
                "confidenceThreshold": confidence_threshold,
                "deadbandBps": deadband_bps,
                "validityDays": validity_days,
            },
        },
        "warning": (
            "Binance-conditional offline diagnostic only. Historical data cannot reconstruct "
            "the live cross-venue quorum, so production-guarded replay abstains. DRAFT, not "
            "approved, registered, or production-ready. Global temperature was not fitted "
            "on the emitted subset and does not establish user-facing calibration."
        ),
    }
    created_outputs: list[Path] = []
    try:
        write_new_json(output_path, artifact)
        created_outputs.append(output_path)
        write_new_json(evaluation_path, evaluation_payload)
        created_outputs.append(evaluation_path)
    except BaseException:
        for created_output in created_outputs:
            created_output.unlink(missing_ok=True)
        raise
    return {
        "artifact": str(output_path.resolve()),
        "evaluation": str(evaluation_path.resolve()),
        "holdout": evaluation,
        "policyReplay": conditional_policy,
    }


def validate_complete_training_window(
    window: str, rows: Sequence[dict[str, object]], signal_type: str
) -> None:
    window_start = parse_timestamp(window)
    observed_offsets = tuple(
        int((parse_timestamp(str(row['decisionAt'])) - window_start).total_seconds())
        for row in rows
    )
    expected_offsets = governed_decision_offsets(signal_type)
    if observed_offsets != expected_offsets:
        raise ValueError(
            f'Training window {window} does not contain the complete governed '
            f'decision schedule; expected {expected_offsets}, received {observed_offsets}'
        )


def iter_training_window_groups(
    path: Path,
    signal_type: str,
    deadband_bps: float,
    audit: dict[str, object] | None = None,
) -> Iterator[tuple[str, list[dict[str, object]]]]:
    current_window: str | None = None
    current_rows: list[dict[str, object]] = []
    previous_key: tuple[str, str] | None = None
    digest = hashlib.sha256()
    byte_count = 0
    row_count = 0
    window_count = 0
    first_decision_at: str | None = None
    last_window_end: str | None = None
    with path.open("rb") as handle:
        for line_number, line_bytes in enumerate(handle, start=1):
            digest.update(line_bytes)
            byte_count += len(line_bytes)
            if not line_bytes or not line_bytes.endswith(b"\n"):
                raise ValueError(f"Training row {line_number} must end with one LF byte")
            try:
                line = line_bytes.decode("utf-8")
            except UnicodeDecodeError as error:
                raise ValueError(f"Training row {line_number} must be strict UTF-8") from error
            if not line.strip():
                raise ValueError(f"Training row {line_number} cannot be blank")
            try:
                raw = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"Invalid JSONL row {line_number}") from error
            try:
                expected_line = (canonical_json(raw) + "\n").encode("utf-8")
            except (TypeError, ValueError) as error:
                raise ValueError(f"Training row {line_number} is not strict finite JSON") from error
            if expected_line != line_bytes:
                raise ValueError(f"Training row {line_number} is not canonically encoded")
            row = validate_training_row(raw, line_number, signal_type, deadband_bps)
            row_count += 1
            first_decision_at = first_decision_at or str(row["decisionAt"])
            last_window_end = str(row["windowEnd"])
            key = (str(row["decisionAt"]), str(row["id"]))
            if previous_key is not None and key <= previous_key:
                raise ValueError("Training rows must have unique monotonic IDs")
            previous_key = key
            window = str(row["windowStart"])
            if current_window is None:
                current_window = window
            elif window != current_window:
                if window < current_window:
                    raise ValueError("Training windows must be monotonic")
                if len({str(item["label"]) for item in current_rows}) != 1:
                    raise ValueError(f"Training window {current_window} has conflicting labels")
                validate_complete_training_window(current_window, current_rows, signal_type)
                window_count += 1
                yield current_window, current_rows
                current_window = window
                current_rows = []
            current_rows.append(row)
    if current_window is not None:
        if len({str(item["label"]) for item in current_rows}) != 1:
            raise ValueError(f"Training window {current_window} has conflicting labels")
        validate_complete_training_window(current_window, current_rows, signal_type)
        window_count += 1
        yield current_window, current_rows
    if audit is not None:
        audit.update(
            {
                "sha256": digest.hexdigest(),
                "byteCount": byte_count,
                "decisionRowCount": row_count,
                "windowCount": window_count,
                "firstDecisionAt": first_decision_at,
                "lastWindowEnd": last_window_end,
            }
        )


def sampled_window_limit(signal_type: str, partition: str) -> int:
    schedule = target_contract(signal_type, DEFAULT_DEADBAND_BPS)["candidateSchedule"]
    rows_per_window = (
        (int(schedule["lastDecisionOffsetSeconds"]) - int(schedule["firstDecisionOffsetSeconds"]))
        // int(schedule["cadenceSeconds"])
        + 1
    )
    return max(15, PARTITION_ROW_BUDGETS[partition] // rows_per_window)


def retain_sampled_window(
    heap: list[tuple[int, str, list[dict[str, object]]]],
    *,
    limit: int,
    partition: str,
    window: str,
    rows: list[dict[str, object]],
) -> None:
    digest = hashlib.sha256(f"20260814:{partition}:{window}".encode()).digest()
    score = int.from_bytes(digest[:8], "big")
    item = (-score, window, rows)
    if len(heap) < limit:
        heapq.heappush(heap, item)
    elif score < -heap[0][0]:
        heapq.heapreplace(heap, item)


def flatten_sampled_windows(
    heap: Sequence[tuple[int, str, list[dict[str, object]]]]
) -> list[dict[str, object]]:
    return [
        row
        for _, _, window_rows in sorted(heap, key=lambda item: item[1])
        for row in window_rows
    ]


def sampled_class_window_counts(
    rows: Sequence[dict[str, object]],
) -> dict[str, int]:
    labels_by_window: dict[str, str] = {}
    for row in rows:
        window = str(row["windowStart"])
        label = str(row["label"])
        previous = labels_by_window.setdefault(window, label)
        if previous != label:
            raise ValueError("Every decision row in a window must share one close label")
    return {
        label: sum(value == label for value in labels_by_window.values())
        for label in CLASS_ORDER
    }


def outcome_support_report(
    rows: Sequence[dict[str, object]], minimum_independent_windows_per_class: int = 20
) -> dict[str, object]:
    if minimum_independent_windows_per_class < 1:
        raise ValueError("Minimum independent-window support must be positive")
    row_counts = {
        label: sum(str(row["label"]) == label for row in rows)
        for label in CLASS_ORDER
    }
    window_counts = sampled_class_window_counts(rows)
    insufficient = {
        label: window_counts[label]
        for label in CLASS_ORDER
        if window_counts[label] < minimum_independent_windows_per_class
    }
    return {
        "supportStatus": "SUFFICIENT" if not insufficient else "INSUFFICIENT_SUPPORT",
        "reason": None
        if not insufficient
        else (
            "Holdout requires at least "
            f"{minimum_independent_windows_per_class} independent windows per class; "
            + ", ".join(f"{label}={count}" for label, count in insufficient.items())
        ),
        "minimumIndependentWindowsPerClass": minimum_independent_windows_per_class,
        "insufficientIndependentWindowCounts": insufficient,
        "rowCounts": row_counts,
        "independentWindowCounts": window_counts,
    }


def load_training_partitions(
    path: Path,
    signal_type: str,
    deadband_bps: float,
    *,
    forbidden_window_starts: set[str] | None = None,
) -> tuple[
    list[dict[str, object]],
    list[dict[str, object]],
    list[dict[str, object]],
    dict[str, object],
]:
    row_count = 0
    window_count = 0
    first_pass_audit: dict[str, object] = {}
    forbidden = forbidden_window_starts or set()
    for window, window_rows in iter_training_window_groups(
        path, signal_type, deadband_bps, first_pass_audit
    ):
        if window in forbidden:
            raise ValueError(
                f"Training window {window} depends on a declared source gap"
            )
        window_count += 1
        row_count += len(window_rows)
    if window_count < 90 or row_count < 90:
        raise ValueError(
            f"At least 90 valid rows and independent windows are required; "
            f"found {row_count} rows and {window_count} windows"
        )
    print(
        f"Validated training corpus: {window_count} windows, {row_count} decision rows.",
        file=sys.stderr,
        flush=True,
    )
    train_end = int(window_count * 0.6)
    calibration_end = int(window_count * 0.8)
    partition_names = ("train", "calibration", "holdout")
    limits = {
        name: sampled_window_limit(signal_type, name)
        for name in partition_names
    }
    heaps: dict[str, list[tuple[int, str, list[dict[str, object]]]]] = {
        name: [] for name in partition_names
    }
    corpus_row_counts = {name: 0 for name in partition_names}
    partition_starts: dict[str, str] = {}
    partition_ends: dict[str, str] = {}
    second_pass_audit: dict[str, object] = {}
    second_pass_window_count = 0
    for ordinal, (window, window_rows) in enumerate(
        iter_training_window_groups(path, signal_type, deadband_bps, second_pass_audit)
    ):
        if window in forbidden:
            raise ValueError(
                f"Training window {window} depends on a declared source gap"
            )
        second_pass_window_count += 1
        partition = (
            "train"
            if ordinal < train_end
            else "calibration"
            if ordinal < calibration_end
            else "holdout"
        )
        corpus_row_counts[partition] += len(window_rows)
        partition_starts.setdefault(partition, window)
        partition_ends[partition] = str(window_rows[-1]["windowEnd"])
        retain_sampled_window(
            heaps[partition],
            limit=limits[partition],
            partition=partition,
            window=window,
            rows=window_rows,
        )
    if first_pass_audit != second_pass_audit:
        raise ValueError("Training corpus changed between validation and sampling passes")
    if second_pass_window_count != window_count:
        raise ValueError("Training corpus window count changed between passes")
    samples = {
        name: flatten_sampled_windows(heaps[name])
        for name in partition_names
    }
    if min(len(heaps[name]) for name in partition_names) < 15:
        raise ValueError("Every sampled partition requires at least 15 windows")
    if (
        parse_timestamp(partition_ends["train"])
        > parse_timestamp(partition_starts["calibration"])
        or parse_timestamp(partition_ends["calibration"])
        > parse_timestamp(partition_starts["holdout"])
    ):
        raise ValueError("Partition label horizons overlap a later partition")
    sampled_windows = {
        name: sorted(item[1] for item in heaps[name]) for name in partition_names
    }
    pre_evaluation_class_window_counts = {
        name: sampled_class_window_counts(samples[name])
        for name in ("train", "calibration")
    }
    corpus_window_counts = {
        "modelFit": train_end,
        "calibration": calibration_end - train_end,
        "evaluation": window_count - calibration_end,
    }
    metadata: dict[str, object] = {
        "method": "DETERMINISTIC_COMPLETE_WINDOW_HASH_RESERVOIR",
        "seed": 20260814,
        "corpusRowCount": row_count,
        "corpusWindowCount": window_count,
        "corpusPartitionWindowCounts": corpus_window_counts,
        "corpusPartitionRowCounts": corpus_row_counts,
        "sampledWindowLimits": limits,
        "sampledWindowCounts": {
            name: len(heaps[name]) for name in partition_names
        },
        "sampledRowCounts": {
            name: len(samples[name]) for name in partition_names
        },
        "sampledClassWindowCounts": pre_evaluation_class_window_counts,
        "sampledWindowSelectionSha256": hashlib.sha256(
            canonical_json(sampled_windows).encode("utf-8")
        ).hexdigest(),
        "partitionStarts": partition_starts,
        "partitionEnds": partition_ends,
        "oodFitScope": "SAMPLED_MODEL_FIT_WINDOWS",
        "evaluationScope": "SAMPLED_DIAGNOSTIC_ONLY",
        "corpusPassAudit": {
            **second_pass_audit,
            "passesMatched": True,
        },
    }
    print(
        "Selected deterministic complete-window samples: "
        + ", ".join(
            f"{name}={len(heaps[name])} windows/{len(samples[name])} rows"
            for name in partition_names
        ),
        file=sys.stderr,
        flush=True,
    )
    return samples["train"], samples["calibration"], samples["holdout"], metadata


def load_training_rows(path: Path, signal_type: str, deadband_bps: float) -> list[dict[str, object]]:
    rows = [
        row
        for _, window_rows in iter_training_window_groups(path, signal_type, deadband_bps)
        for row in window_rows
    ]
    if len(rows) < 90:
        raise ValueError(f"At least 90 valid rows are required; found {len(rows)}")
    return rows


def validate_training_row(
    raw: object, line_number: int, signal_type: str, deadband_bps: float
) -> dict[str, object]:
    if not isinstance(raw, dict):
        raise ValueError(f"Training row {line_number} must be an object")
    required = {
        "schemaVersion", "id", "signalType", "decisionAt", "windowStart", "windowEnd",
        "durationSeconds", "currentRelation", "candidateEligible", "features", "label",
        "deadbandBps", "sourceIntegrityHealthy", "crossVenueGuardAvailability",
        "productionEligible",
    }
    if set(raw) != required:
        raise ValueError(f"Training row {line_number} has an unexpected schema")
    if raw["schemaVersion"] != DATASET_SCHEMA_VERSION or raw["signalType"] != signal_type:
        raise ValueError(f"Training row {line_number} has a schema or signal mismatch")
    if raw["label"] not in CLASS_ORDER or raw["currentRelation"] not in CLASS_ORDER:
        raise ValueError(f"Training row {line_number} has an unknown relation")
    if raw["sourceIntegrityHealthy"] is not True:
        raise ValueError(f"Training row {line_number} failed source integrity")
    if not isinstance(raw["candidateEligible"], bool):
        raise ValueError(f"Training row {line_number} has invalid eligibility")
    if raw["crossVenueGuardAvailability"] != "UNAVAILABLE" or raw["productionEligible"] is not False:
        raise ValueError(f"Training row {line_number} must preserve the offline-only guard boundary")
    if finite_float(raw["deadbandBps"], "deadbandBps") != deadband_bps:
        raise ValueError(f"Training row {line_number} deadband does not match training options")
    expected_duration = SIGNAL_DURATION_SECONDS[signal_type]
    if raw["durationSeconds"] != expected_duration:
        raise ValueError(f"Training row {line_number} has the wrong duration")
    start = parse_timestamp(str(raw["windowStart"]))
    decision = parse_timestamp(str(raw["decisionAt"]))
    end = parse_timestamp(str(raw["windowEnd"]))
    if not (start <= decision < end) or (end - start).total_seconds() != expected_duration:
        raise ValueError(f"Training row {line_number} has invalid time boundaries")
    if (
        format_timestamp(start) != raw["windowStart"]
        or format_timestamp(decision) != raw["decisionAt"]
        or format_timestamp(end) != raw["windowEnd"]
        or start.microsecond != 0
        or int(start.timestamp()) % expected_duration != 0
    ):
        raise ValueError(f"Training row {line_number} does not use canonical UTC alignment")
    offset_seconds = (decision - start).total_seconds()
    if not offset_seconds.is_integer():
        raise ValueError(f"Training row {line_number} has a fractional decision offset")
    offset = int(offset_seconds)
    governed_options = DatasetOptions(
        signal_type=signal_type,
        deadband_bps=deadband_bps,
        timeframe_minutes=expected_duration // 60,
        decision_cadence_seconds=DEFAULT_DECISION_CADENCE_SECONDS,
        minimum_lead_time_seconds=SIGNAL_MINIMUM_LEAD_TIME_SECONDS[signal_type],
    )
    if offset not in decision_offsets(signal_type, expected_duration, governed_options):
        raise ValueError(f"Training row {line_number} is outside the governed decision schedule")
    expected_id = (
        f"{SUPPORTED_SYMBOL}:{format_timestamp(start)}:{signal_type}:{offset}"
    )
    if raw["id"] != expected_id:
        raise ValueError(f"Training row {line_number} has a noncanonical identity")
    features = raw["features"]
    if not isinstance(features, dict) or tuple(features) != FEATURE_NAMES:
        raise ValueError(f"Training row {line_number} has the wrong feature schema/order")
    feature_values: dict[str, float] = {}
    for name in FEATURE_NAMES:
        feature_values[name] = finite_float(
            features[name], f"row {line_number} feature {name}"
        )
    expected_current_relation = relation_from_return_bps(
        feature_values["current_return_from_open_bps"], deadband_bps
    )
    if raw["currentRelation"] != expected_current_relation:
        raise ValueError(
            f"Training row {line_number} current relation does not match its measured return"
        )
    expected_eligibility = signal_candidate_eligible(
        signal_type, expected_current_relation, offset
    )
    if raw["candidateEligible"] is not expected_eligibility:
        raise ValueError(f"Training row {line_number} has inconsistent eligibility")
    for name in (
        "previous_range_bps", "previous_volume_log1p", "previous_trade_count_log1p",
        "current_range_bps", "current_volume_log1p", "current_trade_count_log1p",
        "realized_volatility_12", "mean_range_12_bps", "previous_volume_relative_12",
        "previous_trade_count_relative_12", "current_volume_rate_log1p",
        "current_trade_rate_log1p", "current_volume_rate_relative_12",
        "current_trade_rate_relative_12",
    ):
        if feature_values[name] < 0:
            raise ValueError(f"Training row {line_number} has negative feature {name}")
    for name in (
        "previous_buy_ratio", "previous_close_location", "current_buy_ratio",
        "current_close_location", "elapsed_ratio", "remaining_ratio",
    ):
        if not 0 <= feature_values[name] <= 1:
            raise ValueError(f"Training row {line_number} has out-of-range feature {name}")
    expected_elapsed = offset / expected_duration
    if (
        not math.isclose(feature_values["elapsed_ratio"], expected_elapsed, abs_tol=1e-12)
        or not math.isclose(
            feature_values["remaining_ratio"], 1 - expected_elapsed, abs_tol=1e-12
        )
    ):
        raise ValueError(f"Training row {line_number} has inconsistent time-ratio features")
    return raw


def chronological_split(
    rows: Sequence[dict[str, object]], train_fraction: float = 0.6, calibration_fraction: float = 0.2
) -> tuple[list[dict[str, object]], list[dict[str, object]], list[dict[str, object]]]:
    windows = sorted({str(row["windowStart"]) for row in rows})
    if len(windows) < 90:
        raise ValueError(f"At least 90 independent windows are required; found {len(windows)}")
    train_boundary = int(len(windows) * train_fraction)
    calibration_boundary = int(len(windows) * (train_fraction + calibration_fraction))
    train_windows = set(windows[:train_boundary])
    calibration_windows = set(windows[train_boundary:calibration_boundary])
    holdout_windows = set(windows[calibration_boundary:])
    calibration_start = parse_timestamp(windows[train_boundary])
    holdout_start = parse_timestamp(windows[calibration_boundary])
    train = [
        row for row in rows
        if str(row["windowStart"]) in train_windows
        and parse_timestamp(str(row["windowEnd"])) <= calibration_start
    ]
    calibration = [
        row for row in rows
        if str(row["windowStart"]) in calibration_windows
        and parse_timestamp(str(row["windowEnd"])) <= holdout_start
    ]
    holdout = [row for row in rows if str(row["windowStart"]) in holdout_windows]
    if min(len({str(row["windowStart"]) for row in part}) for part in (train, calibration, holdout)) < 15:
        raise ValueError("Purged chronological partitions require at least 15 independent windows each")
    return train, calibration, holdout


def walk_forward_evaluation(rows: Sequence[dict[str, object]]) -> dict[str, object]:
    folds: list[dict[str, object]] = []
    skipped_folds: list[dict[str, object]] = []
    windows = sorted({str(row["windowStart"]) for row in rows})
    boundaries = ((0.50, 0.65, 0.75), (0.60, 0.75, 0.85), (0.70, 0.85, 1.00))
    for fold_index, (train_fraction, calibration_fraction, end_fraction) in enumerate(
        boundaries, start=1
    ):
        train_end = int(len(windows) * train_fraction)
        calibration_end = int(len(windows) * calibration_fraction)
        test_end = int(len(windows) * end_fraction)
        train_set = set(windows[:train_end])
        calibration_set = set(windows[train_end:calibration_end])
        test_set = set(windows[calibration_end:test_end])
        train = [row for row in rows if str(row["windowStart"]) in train_set]
        calibration = [row for row in rows if str(row["windowStart"]) in calibration_set]
        test = [row for row in rows if str(row["windowStart"]) in test_set]
        window_counts = {
            "training": len(train_set),
            "calibration": len(calibration_set),
            "evaluation": len(test_set),
        }
        if min(len(train_set), len(calibration_set), len(test_set)) < 15:
            skipped_folds.append(
                {
                    "foldIndex": fold_index,
                    "status": "INSUFFICIENT_SUPPORT",
                    "reason": "Every walk-forward partition requires at least 15 windows",
                    "windowCounts": window_counts,
                }
            )
            continue
        try:
            means, scales = fit_normalization(train, FEATURE_NAMES)
            train_y = labels(train)
            calibration_y = labels(calibration)
            test_y = labels(test)
            require_class_support(train_y, "walk-forward training")
            require_class_support(calibration_y, "walk-forward calibration")
            require_class_window_support(train, "walk-forward training")
            require_class_window_support(calibration, "walk-forward calibration")
            require_class_window_support(test, "walk-forward evaluation")
            weights, biases, _ = fit_multinomial(
                feature_matrix(train, FEATURE_NAMES, means, scales),
                train_y,
                window_balanced_weights(train),
            )
            calibration_logits = feature_matrix(calibration, FEATURE_NAMES, means, scales) @ weights.T + biases
            temperature = fit_temperature(
                calibration_logits,
                calibration_y,
                window_balanced_weights(calibration),
            )
            probabilities = softmax(
                (feature_matrix(test, FEATURE_NAMES, means, scales) @ weights.T + biases) / temperature
            )
            folds.append({
                "foldIndex": fold_index,
                "status": "SUFFICIENT",
                "windowCounts": window_counts,
                "trainThrough": str(train[-1]["decisionAt"]),
                "testStart": str(test[0]["decisionAt"]),
                "testEnd": str(test[-1]["decisionAt"]),
                "metrics": evaluate_probabilities(probabilities, test_y),
                "windowBalancedMetrics": evaluate_probabilities(
                    probabilities, test_y, window_balanced_weights(test)
                ),
            })
        except ValueError as error:
            skipped_folds.append(
                {
                    "foldIndex": fold_index,
                    "status": "FAILED_VALIDATION",
                    "reason": str(error),
                    "windowCounts": window_counts,
                }
            )
    support_status = (
        "SUFFICIENT"
        if len(folds) == len(boundaries)
        else "PARTIAL_SUPPORT"
        if folds
        else "INSUFFICIENT_SUPPORT"
    )
    return {
        "supportStatus": support_status,
        "plannedFoldCount": len(boundaries),
        "foldCount": len(folds),
        "folds": folds,
        "skippedFolds": skipped_folds,
    }


def challenger_scaffold() -> dict[str, object]:
    availability: dict[str, bool] = {}
    for module_name in ("lightgbm", "xgboost"):
        availability[module_name] = importlib.util.find_spec(module_name) is not None
    return {
        "status": "NOT_RUN",
        "availableLibraries": availability,
        "selectionPartition": "CALIBRATION_ONLY",
        "finalHoldoutPolicy": "UNTOUCHED_UNTIL_CANDIDATE_AND_THRESHOLD_ARE_FROZEN",
        "selectionMetrics": [
            "multiclassLogLoss",
            "brierScore",
            "expectedCalibrationError",
            "policyPrecision",
            "policyCoverage",
        ],
        "artifactBoundary": (
            "Governed v3 output remains MULTINOMIAL_LOGISTIC until a challenger runtime "
            "contract and independent validation exist."
        ),
    }


def fit_normalization(
    rows: Sequence[dict[str, object]], names: Sequence[str]
) -> tuple[np.ndarray, np.ndarray]:
    matrix = np.asarray([[float(row["features"][name]) for name in names] for row in rows])
    sample_weights = window_balanced_weights(rows)
    means = np.average(matrix, axis=0, weights=sample_weights)
    variance = np.average((matrix - means) ** 2, axis=0, weights=sample_weights)
    scales = np.maximum(np.sqrt(variance), 1e-9)
    return means, scales


def feature_matrix(
    rows: Sequence[dict[str, object]], names: Sequence[str], means: np.ndarray, scales: np.ndarray
) -> np.ndarray:
    values = np.asarray([[float(row["features"][name]) for name in names] for row in rows], dtype=float)
    if not np.all(np.isfinite(values)):
        raise ValueError("Feature matrix contains non-finite values")
    return (values - means) / scales


def labels(rows: Sequence[dict[str, object]]) -> np.ndarray:
    mapping = {name: index for index, name in enumerate(CLASS_ORDER)}
    return np.asarray([mapping[str(row["label"])] for row in rows], dtype=int)


def require_class_support(expected: np.ndarray, partition: str) -> None:
    missing = [name for index, name in enumerate(CLASS_ORDER) if int(np.sum(expected == index)) == 0]
    if missing:
        raise ValueError(f"{partition} partition is missing classes: {', '.join(missing)}")


def require_class_window_support(
    rows: Sequence[dict[str, object]], partition: str, minimum: int = 20
) -> None:
    by_window: dict[str, str] = {}
    for row in rows:
        window = str(row["windowStart"])
        label = str(row["label"])
        previous = by_window.setdefault(window, label)
        if previous != label:
            raise ValueError(f"{partition} window {window} has conflicting labels")
    counts = {
        label: sum(window_label == label for window_label in by_window.values())
        for label in CLASS_ORDER
    }
    insufficient = [label for label, count in counts.items() if count < minimum]
    if insufficient:
        raise ValueError(
            f"{partition} partition needs at least {minimum} windows for every class: "
            + ", ".join(insufficient)
        )


def window_balanced_weights(rows: Sequence[dict[str, object]]) -> np.ndarray:
    if not rows:
        raise ValueError("Cannot weight an empty partition")
    counts: dict[str, int] = {}
    for row in rows:
        window = str(row["windowStart"])
        counts[window] = counts.get(window, 0) + 1
    weights = np.asarray(
        [1.0 / counts[str(row["windowStart"])] for row in rows], dtype=float
    )
    return weights * (len(weights) / float(np.sum(weights)))


def fit_multinomial(
    features: np.ndarray,
    expected: np.ndarray,
    sample_weights: np.ndarray | None = None,
    *,
    batch_size_limit: int = 4_096,
    maximum_epochs: int = 1_000,
) -> tuple[np.ndarray, np.ndarray, dict[str, object]]:
    if (
        features.ndim != 2
        or len(features) == 0
        or expected.shape != (len(features),)
        or not np.all(np.isfinite(features))
        or np.any(expected < 0)
        or np.any(expected >= len(CLASS_ORDER))
    ):
        raise ValueError("Model fitting inputs are empty, non-finite, or dimensionally invalid")
    if batch_size_limit < 1 or maximum_epochs < 2:
        raise ValueError("Optimizer batch size and maximum epochs are invalid")
    weights = np.zeros((len(CLASS_ORDER), features.shape[1]), dtype=float)
    biases = np.zeros(len(CLASS_ORDER), dtype=float)
    one_hot = np.eye(len(CLASS_ORDER), dtype=float)[expected]
    observation_weights = (
        np.ones(len(features), dtype=float)
        if sample_weights is None
        else np.asarray(sample_weights, dtype=float)
    )
    if (
        observation_weights.shape != (len(features),)
        or not np.all(np.isfinite(observation_weights))
        or np.any(observation_weights <= 0)
    ):
        raise ValueError("Model sample weights must be finite and positive")
    l2 = 0.001
    exact_gradient_l2_tolerance = 1e-5
    plateau_objective_tolerance = 1e-7
    plateau_gradient_infinity_tolerance = 5e-4
    plateau_epochs_required = 20
    minimum_plateau_epoch = 25
    batch_size = min(batch_size_limit, len(features))
    step_size = 1.0
    previous_loss: float | None = None
    plateau_count = 0
    convergence_reason: str | None = None
    loss_trace: list[dict[str, float | int]] = []
    iterations = 0
    final_loss = math.inf
    final_gradient_norm = math.inf
    final_gradient_infinity_norm = math.inf
    final_relative_improvement: float | None = None
    for iterations in range(1, maximum_epochs + 1):
        loss, gradient_weights, gradient_biases = multinomial_objective_and_gradient(
            features,
            expected,
            one_hot,
            observation_weights,
            weights,
            biases,
            l2,
            batch_size,
        )
        gradient_squared = float(
            np.sum(gradient_weights**2) + np.sum(gradient_biases**2)
        )
        gradient_norm = math.sqrt(gradient_squared)
        gradient_infinity_norm = float(
            max(np.max(np.abs(gradient_weights)), np.max(np.abs(gradient_biases)))
        )
        if (
            not math.isfinite(loss)
            or not math.isfinite(gradient_norm)
            or not math.isfinite(gradient_infinity_norm)
        ):
            raise ValueError("Model fitting produced a non-finite objective or gradient")
        final_loss = loss
        final_gradient_norm = gradient_norm
        final_gradient_infinity_norm = gradient_infinity_norm
        if iterations == 1 or iterations % 5 == 0:
            loss_trace.append(
                {
                    "epoch": iterations,
                    "objective": loss,
                    "gradientNorm": gradient_norm,
                    "gradientInfinityNorm": gradient_infinity_norm,
                }
            )
        if gradient_norm <= exact_gradient_l2_tolerance:
            convergence_reason = "GRADIENT_NORM"
            break
        if previous_loss is not None:
            relative_improvement = (previous_loss - loss) / max(
                1.0, abs(previous_loss)
            )
            final_relative_improvement = relative_improvement
            if relative_improvement < -1e-12:
                raise ValueError("Model optimizer objective increased after an accepted step")
            plateau_count = (
                plateau_count + 1
                if (
                    0.0 <= relative_improvement <= plateau_objective_tolerance
                    and gradient_infinity_norm
                    <= plateau_gradient_infinity_tolerance
                )
                else 0
            )
            if (
                iterations >= minimum_plateau_epoch
                and plateau_count >= plateau_epochs_required
            ):
                convergence_reason = "OBJECTIVE_PLATEAU_WITH_BOUNDED_GRADIENT"
                break
        previous_loss = loss

        trial_step = min(1.0, step_size * 1.5)
        accepted = False
        for _ in range(24):
            candidate_weights = weights - trial_step * gradient_weights
            candidate_biases = biases - trial_step * gradient_biases
            candidate_loss = multinomial_objective(
                features,
                expected,
                observation_weights,
                candidate_weights,
                candidate_biases,
                l2,
                batch_size,
            )
            if (
                math.isfinite(candidate_loss)
                and candidate_loss <= loss - 1e-4 * trial_step * gradient_squared
            ):
                weights = candidate_weights
                biases = candidate_biases
                step_size = trial_step
                accepted = True
                break
            trial_step *= 0.5
        if not accepted:
            raise ValueError("Model optimizer line search failed to reduce the objective")
        if iterations % 25 == 0:
            print(
                f"Optimizer epoch {iterations}/{maximum_epochs} objective={loss:.8f} "
                f"gradient={gradient_norm:.8g}",
                file=sys.stderr,
                flush=True,
            )
    if convergence_reason is None:
        raise ValueError(
            f"Model optimizer failed to converge after {maximum_epochs} epochs "
            f"(objective={final_loss:.8f}, gradientL2={final_gradient_norm:.8g}, "
            f"gradientInfinity={final_gradient_infinity_norm:.8g})"
        )
    if not np.all(np.isfinite(weights)) or not np.all(np.isfinite(biases)):
        raise ValueError("Model fitting produced non-finite parameters")
    if not loss_trace or loss_trace[-1]["epoch"] != iterations:
        loss_trace.append(
            {
                "epoch": iterations,
                "objective": final_loss,
                "gradientNorm": final_gradient_norm,
                "gradientInfinityNorm": final_gradient_infinity_norm,
            }
        )
    return weights, biases, {
        "iterations": iterations,
        "converged": True,
        "convergenceReason": convergence_reason,
        "objective": final_loss,
        "gradientNorm": final_gradient_norm,
        "gradientInfinityNorm": final_gradient_infinity_norm,
        "signedRelativeObjectiveImprovement": final_relative_improvement,
        "finalStepSize": step_size,
        "l2": l2,
        "batchSize": batch_size,
        "maximumEpochs": maximum_epochs,
        "convergenceThresholds": {
            "exactGradientL2": exact_gradient_l2_tolerance,
            "plateauRelativeObjectiveImprovement": plateau_objective_tolerance,
            "plateauGradientInfinity": plateau_gradient_infinity_tolerance,
            "plateauEpochs": plateau_epochs_required,
            "minimumPlateauEpoch": minimum_plateau_epoch,
        },
        "optimizer": "BATCHED_FULL_OBJECTIVE_GRADIENT_DESCENT_WITH_ARMIJO",
        "lossTrace": loss_trace,
    }


def multinomial_objective_and_gradient(
    features: np.ndarray,
    expected: np.ndarray,
    one_hot: np.ndarray,
    observation_weights: np.ndarray,
    weights: np.ndarray,
    biases: np.ndarray,
    l2: float,
    batch_size: int,
) -> tuple[float, np.ndarray, np.ndarray]:
    total_weight = float(np.sum(observation_weights))
    weighted_loss = 0.0
    gradient_weights = np.zeros_like(weights)
    gradient_biases = np.zeros_like(biases)
    for start in range(0, len(features), batch_size):
        stop = min(start + batch_size, len(features))
        batch_features = features[start:stop]
        batch_expected = expected[start:stop]
        batch_weights = observation_weights[start:stop]
        logits = batch_features @ weights.T + biases
        probabilities, log_normalizer = softmax_and_log_normalizer(logits)
        losses = log_normalizer - logits[np.arange(stop - start), batch_expected]
        if not np.all(np.isfinite(losses)):
            raise ValueError("Model fitting produced a non-finite cross-entropy loss")
        weighted_loss += float(np.sum(losses * batch_weights))
        error = (probabilities - one_hot[start:stop]) * batch_weights[:, np.newaxis]
        gradient_weights += error.T @ batch_features
        gradient_biases += np.sum(error, axis=0)
    objective = weighted_loss / total_weight + 0.5 * l2 * float(np.sum(weights**2))
    gradient_weights = gradient_weights / total_weight + l2 * weights
    gradient_biases /= total_weight
    return objective, gradient_weights, gradient_biases


def multinomial_objective(
    features: np.ndarray,
    expected: np.ndarray,
    observation_weights: np.ndarray,
    weights: np.ndarray,
    biases: np.ndarray,
    l2: float,
    batch_size: int,
) -> float:
    total_weight = float(np.sum(observation_weights))
    weighted_loss = 0.0
    for start in range(0, len(features), batch_size):
        stop = min(start + batch_size, len(features))
        logits = features[start:stop] @ weights.T + biases
        _, log_normalizer = softmax_and_log_normalizer(logits)
        losses = log_normalizer - logits[np.arange(stop - start), expected[start:stop]]
        if not np.all(np.isfinite(losses)):
            raise ValueError("Model fitting produced a non-finite cross-entropy loss")
        weighted_loss += float(np.sum(losses * observation_weights[start:stop]))
    return weighted_loss / total_weight + 0.5 * l2 * float(np.sum(weights**2))


def softmax_and_log_normalizer(logits: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if logits.ndim != 2 or logits.shape[1] != len(CLASS_ORDER) or not np.all(np.isfinite(logits)):
        raise ValueError("Softmax logits must be a finite two-dimensional class matrix")
    maximum = np.max(logits, axis=1, keepdims=True)
    shifted = logits - maximum
    with np.errstate(over="ignore", under="ignore", invalid="ignore"):
        exponentials = np.exp(shifted)
        exponential_sum = np.sum(exponentials, axis=1, keepdims=True)
        probabilities = exponentials / exponential_sum
        log_normalizer = maximum[:, 0] + np.log(exponential_sum[:, 0])
    if not np.all(np.isfinite(probabilities)) or not np.all(np.isfinite(log_normalizer)):
        raise ValueError("Softmax produced a non-finite probability or log normalizer")
    return probabilities, log_normalizer


def softmax(logits: np.ndarray) -> np.ndarray:
    probabilities, _ = softmax_and_log_normalizer(logits)
    return probabilities


def fit_temperature(
    logits: np.ndarray, expected: np.ndarray, sample_weights: np.ndarray | None = None
) -> float:
    candidates = np.exp(np.linspace(math.log(0.1), math.log(10.0), 256))
    losses = [
        multiclass_log_loss(softmax(logits / candidate), expected, sample_weights)
        for candidate in candidates
    ]
    return float(candidates[int(np.argmin(losses))])


def multiclass_log_loss(
    probabilities: np.ndarray,
    expected: np.ndarray,
    sample_weights: np.ndarray | None = None,
) -> float:
    selected = np.clip(probabilities[np.arange(len(expected)), expected], 1e-12, 1.0)
    losses = -np.log(selected)
    if sample_weights is None:
        return float(np.mean(losses))
    weights = np.asarray(sample_weights, dtype=float)
    if weights.shape != losses.shape or not np.all(np.isfinite(weights)) or np.any(weights <= 0):
        raise ValueError("Metric sample weights must be finite and positive")
    return float(np.average(losses, weights=weights))


def evaluate_probabilities(
    probabilities: np.ndarray,
    expected: np.ndarray,
    sample_weights: np.ndarray | None = None,
) -> dict[str, object]:
    metric_weights = (
        np.ones(len(expected), dtype=float)
        if sample_weights is None
        else np.asarray(sample_weights, dtype=float)
    )
    if (
        metric_weights.shape != (len(expected),)
        or not np.all(np.isfinite(metric_weights))
        or np.any(metric_weights <= 0)
    ):
        raise ValueError("Metric sample weights must be finite and positive")
    total_weight = float(np.sum(metric_weights))
    predictions = np.argmax(probabilities, axis=1)
    one_hot = np.eye(len(CLASS_ORDER), dtype=float)[expected]
    brier = float(
        np.average(np.sum((probabilities - one_hot) ** 2, axis=1), weights=metric_weights)
    )
    bins: list[dict[str, object]] = []
    ece = 0.0
    maximum_bin_error = 0.0
    confidence = np.max(probabilities, axis=1)
    correct = predictions == expected
    for lower in np.linspace(0, 0.9, 10):
        upper = lower + 0.1
        selected = (confidence >= lower) & (confidence < upper if upper < 1 else confidence <= 1)
        count = int(np.sum(selected))
        if count == 0:
            continue
        selected_weights = metric_weights[selected]
        bin_weight = float(np.sum(selected_weights))
        average_confidence = float(np.average(confidence[selected], weights=selected_weights))
        accuracy = float(np.average(correct[selected], weights=selected_weights))
        error = abs(average_confidence - accuracy)
        ece += bin_weight / total_weight * error
        maximum_bin_error = max(maximum_bin_error, error)
        bins.append({
            "lower": float(lower), "upper": float(upper), "count": count,
            "effectiveWeight": bin_weight,
            "averageConfidence": average_confidence, "accuracy": accuracy, "absoluteError": error,
        })
    per_class: dict[str, dict[str, float | int]] = {}
    for index, name in enumerate(CLASS_ORDER):
        actual = expected == index
        predicted = predictions == index
        true_positive_weight = float(np.sum(metric_weights[actual & predicted]))
        predicted_count = int(np.sum(predicted))
        actual_count = int(np.sum(actual))
        predicted_weight = float(np.sum(metric_weights[predicted]))
        actual_weight = float(np.sum(metric_weights[actual]))
        per_class[name] = {
            "count": actual_count,
            "predictedCount": predicted_count,
            "precision": true_positive_weight / predicted_weight if predicted_weight else 0.0,
            "recall": true_positive_weight / actual_weight if actual_weight else 0.0,
        }
    return {
        "sampleCount": int(len(expected)),
        "effectiveSampleWeight": total_weight,
        "accuracy": float(np.average(correct, weights=metric_weights)),
        "brierScore": brier,
        "logLoss": multiclass_log_loss(probabilities, expected, metric_weights),
        "expectedCalibrationError": ece,
        "maximumCalibrationBinError": maximum_bin_error,
        "calibrationBins": bins,
        "classMetrics": per_class,
    }


def time_block_metric_intervals(
    rows: Sequence[dict[str, object]],
    probabilities: np.ndarray,
    expected: np.ndarray,
    *,
    seed: int = 20260813,
    resamples: int = 500,
) -> dict[str, object]:
    if len(rows) != len(probabilities) or len(rows) != len(expected):
        raise ValueError('Uncertainty inputs must have identical row counts')
    if resamples < 1:
        raise ValueError('Uncertainty resamples must be positive')
    windows = {str(row['windowStart']) for row in rows}
    day_indices: dict[date, list[int]] = {}
    for index, row in enumerate(rows):
        raw_window_start = str(row['windowStart'])
        window_start = parse_timestamp(raw_window_start)
        if format_timestamp(window_start) != raw_window_start:
            raise ValueError('Uncertainty window starts must be canonical UTC timestamps')
        day_indices.setdefault(window_start.date(), []).append(index)
    observed_days = sorted(day_indices)
    if observed_days:
        calendar_day_count = (observed_days[-1] - observed_days[0]).days + 1
        calendar_days = [
            observed_days[0] + timedelta(days=offset)
            for offset in range(calendar_day_count)
        ]
    else:
        calendar_day_count = 0
        calendar_days = []
    block_length_days = 7
    metadata = {
        'method': 'MOVING_BLOCK_BOOTSTRAP_CONTIGUOUS_UTC_DAYS',
        'timeUnit': 'UTC_DAY',
        'uniqueWindowCount': len(windows),
        'uniqueDayCount': len(observed_days),
        'observedCalendarDayCount': len(observed_days),
        'calendarDayCount': calendar_day_count,
        'missingCalendarDayCount': calendar_day_count - len(observed_days),
        'blockLengthDays': block_length_days,
        'independentBlockCount': calendar_day_count // block_length_days,
        'seed': seed,
        'requestedResamples': resamples,
    }
    if len(windows) < 100 or len(observed_days) < 28 or calendar_day_count < 28:
        return {
            **metadata,
            'supportStatus': 'INSUFFICIENT_SUPPORT',
            'reason': 'At least 100 unique windows across 28 observed UTC days are required',
            'resamples': 0,
            'logLossCi95': None,
            'brierScoreCi95': None,
            'expectedCalibrationErrorCi95': None,
        }
    random = np.random.default_rng(seed)
    values: dict[str, list[float]] = {
        'logLoss': [],
        'brierScore': [],
        'expectedCalibrationError': [],
    }
    original_weights = window_balanced_weights(rows)
    for _ in range(resamples):
        sampled_day_indices: list[int] = []
        while len(sampled_day_indices) < calendar_day_count:
            start = int(
                random.integers(0, calendar_day_count - block_length_days + 1)
            )
            sampled_day_indices.extend(
                start + offset for offset in range(block_length_days)
            )
        selected_rows = [
            index
            for day_index in sampled_day_indices[:calendar_day_count]
            for index in day_indices.get(calendar_days[day_index], ())
        ]
        if not selected_rows:
            continue
        selected = np.asarray(selected_rows, dtype=int)
        metrics = evaluate_probabilities(
            probabilities[selected],
            expected[selected],
            original_weights[selected],
        )
        for name in values:
            values[name].append(float(metrics[name]))
    completed_resamples = len(values['logLoss'])
    if completed_resamples == 0:
        return {
            **metadata,
            'supportStatus': 'INSUFFICIENT_SUPPORT',
            'reason': 'Calendar block resamples did not retain measurable support',
            'resamples': 0,
            'logLossCi95': None,
            'brierScoreCi95': None,
            'expectedCalibrationErrorCi95': None,
        }
    return {
        **metadata,
        'supportStatus': 'SUFFICIENT',
        'resamples': completed_resamples,
        'logLossCi95': [
            float(value) for value in np.quantile(values['logLoss'], (0.025, 0.975))
        ],
        'brierScoreCi95': [
            float(value)
            for value in np.quantile(values['brierScore'], (0.025, 0.975))
        ],
        'expectedCalibrationErrorCi95': [
            float(value)
            for value in np.quantile(
                values['expectedCalibrationError'], (0.025, 0.975)
            )
        ],
    }


def global_frequency_baseline(
    train_expected: np.ndarray, test_expected: np.ndarray
) -> dict[str, object]:
    probabilities = np.bincount(train_expected, minlength=len(CLASS_ORDER)).astype(float)
    probabilities /= np.sum(probabilities)
    matrix = np.repeat(probabilities[np.newaxis, :], len(test_expected), axis=0)
    return {
        "kind": "GLOBAL_TRAIN_CLASS_FREQUENCY",
        "probabilities": probabilities.tolist(),
        **evaluate_probabilities(matrix, test_expected),
    }


def conditional_baseline(
    train_rows: Sequence[dict[str, object]],
    test_rows: Sequence[dict[str, object]],
    test_expected: np.ndarray,
) -> dict[str, object]:
    global_counts = np.ones(len(CLASS_ORDER), dtype=float)
    conditional_counts: dict[tuple[str, int], np.ndarray] = {}
    mapping = {name: index for index, name in enumerate(CLASS_ORDER)}
    for row in train_rows:
        label = mapping[str(row["label"])]
        global_counts[label] += 1
        key = baseline_condition(row)
        conditional_counts.setdefault(key, np.ones(len(CLASS_ORDER), dtype=float))[label] += 1
    global_probability = global_counts / np.sum(global_counts)
    probabilities = []
    for row in test_rows:
        counts = conditional_counts.get(baseline_condition(row))
        probabilities.append(global_probability if counts is None else counts / np.sum(counts))
    matrix = np.asarray(probabilities, dtype=float)
    return {
        "kind": "TRAIN_CURRENT_RELATION_PHASE_FREQUENCY",
        "conditionCount": len(conditional_counts),
        **evaluate_probabilities(matrix, test_expected),
    }


def baseline_condition(row: dict[str, object]) -> tuple[str, int]:
    elapsed = float(row["features"]["elapsed_ratio"])
    phase_bucket = min(3, int(elapsed * 4))
    return str(row["currentRelation"]), phase_bucket


def brier_skill(model_brier: object, baseline_brier: object) -> float:
    baseline = float(baseline_brier)
    return 0.0 if baseline <= 0 else 1.0 - float(model_brier) / baseline


def select_baseline_on_calibration(
    train_rows: Sequence[dict[str, object]],
    train_expected: np.ndarray,
    calibration_rows: Sequence[dict[str, object]],
    calibration_expected: np.ndarray,
) -> tuple[str, dict[str, dict[str, object]]]:
    candidates = {
        "GLOBAL_TRAIN_CLASS_FREQUENCY": global_frequency_baseline(
            train_expected, calibration_expected
        ),
        "TRAIN_CURRENT_RELATION_PHASE_FREQUENCY": conditional_baseline(
            train_rows, calibration_rows, calibration_expected
        ),
    }
    selected = min(
        candidates,
        key=lambda name: (float(candidates[name]["brierScore"]), name),
    )
    return selected, candidates


def build_pre_evaluation_policy(
    *,
    signal_type: str,
    target: dict[str, object],
    feature_names: Sequence[str],
    normalization: tuple[np.ndarray, np.ndarray],
    weights: np.ndarray,
    biases: np.ndarray,
    temperature: float,
    ood: dict[str, object],
    fit_diagnostics: dict[str, object],
    sampling: dict[str, object],
    selected_baseline_kind: str,
    confidence_threshold: float,
    deadband_bps: float,
) -> dict[str, object]:
    fit_state = {
        "normalization": {
            "means": normalization[0].tolist(),
            "scales": normalization[1].tolist(),
        },
        "weights": weights.tolist(),
        "biases": biases.tolist(),
        "temperature": temperature,
        "ood": ood,
        "fitDiagnostics": fit_diagnostics,
    }
    sampling_policy = pre_evaluation_sampling_contract(sampling)
    target_json_preimage = canonical_preimage_json(target)
    fit_state_json_preimage = canonical_preimage_json(fit_state)
    sampling_json_preimage = canonical_preimage_json(sampling_policy)
    return {
        "schemaVersion": PRE_EVALUATION_POLICY_SCHEMA_VERSION,
        "canonicalization": PRE_EVALUATION_POLICY_CANONICALIZATION,
        "signalType": signal_type,
        "targetJsonPreimage": target_json_preimage,
        "targetSha256": hashlib.sha256(target_json_preimage.encode("utf-8")).hexdigest(),
        "featureNames": list(feature_names),
        "fitStateJsonPreimage": fit_state_json_preimage,
        "fitStateSha256": hashlib.sha256(
            fit_state_json_preimage.encode("utf-8")
        ).hexdigest(),
        "samplingJsonPreimage": sampling_json_preimage,
        "samplingSha256": hashlib.sha256(
            sampling_json_preimage.encode("utf-8")
        ).hexdigest(),
        "baselineSelectionPartition": "CALIBRATION",
        "selectedBaselineKind": selected_baseline_kind,
        "confidenceThresholdDecimal": canonical_decimal_string(confidence_threshold),
        "deadbandBpsDecimal": canonical_decimal_string(deadband_bps),
        "thresholdSelection": "PREDECLARED_NO_EVALUATION_ACCESS",
        "challengerSelection": "NOT_RUN",
        "evaluationUse": "REPORT_ONLY_NO_MODEL_OR_POLICY_SELECTION",
    }


def pre_evaluation_sampling_contract(sampling: dict[str, object]) -> dict[str, object]:
    structural_fields = (
        "method",
        "seed",
        "corpusRowCount",
        "corpusWindowCount",
        "corpusPartitionWindowCounts",
        "corpusPartitionRowCounts",
        "sampledWindowLimits",
        "sampledWindowCounts",
        "sampledRowCounts",
        "sampledWindowSelectionSha256",
        "partitionStarts",
        "partitionEnds",
        "oodFitScope",
        "evaluationScope",
    )
    missing = [name for name in structural_fields if name not in sampling]
    if missing:
        raise ValueError(
            "Sampling metadata is missing pre-evaluation structural fields: "
            + ", ".join(missing)
        )
    return {name: sampling[name] for name in structural_fields}


def policy_digest(policy: dict[str, object]) -> str:
    validate_pre_evaluation_policy(policy)
    return hashlib.sha256(canonical_policy_json(policy).encode("utf-8")).hexdigest()


def validate_pre_evaluation_policy(policy: dict[str, object]) -> None:
    required = {
        "schemaVersion",
        "canonicalization",
        "signalType",
        "targetJsonPreimage",
        "targetSha256",
        "featureNames",
        "fitStateJsonPreimage",
        "fitStateSha256",
        "samplingJsonPreimage",
        "samplingSha256",
        "baselineSelectionPartition",
        "selectedBaselineKind",
        "confidenceThresholdDecimal",
        "deadbandBpsDecimal",
        "thresholdSelection",
        "challengerSelection",
        "evaluationUse",
    }
    if set(policy) != required:
        raise ValueError("Pre-evaluation policy has an unexpected schema")
    if (
        policy["schemaVersion"] != PRE_EVALUATION_POLICY_SCHEMA_VERSION
        or policy["canonicalization"] != PRE_EVALUATION_POLICY_CANONICALIZATION
        or policy["signalType"] not in SIGNAL_TYPES
        or policy["featureNames"] != list(FEATURE_NAMES)
        or policy["baselineSelectionPartition"] != "CALIBRATION"
        or policy["selectedBaselineKind"]
        not in {
            "GLOBAL_TRAIN_CLASS_FREQUENCY",
            "TRAIN_CURRENT_RELATION_PHASE_FREQUENCY",
        }
        or policy["thresholdSelection"] != "PREDECLARED_NO_EVALUATION_ACCESS"
        or policy["challengerSelection"] != "NOT_RUN"
        or policy["evaluationUse"]
        != "REPORT_ONLY_NO_MODEL_OR_POLICY_SELECTION"
    ):
        raise ValueError("Pre-evaluation policy violates the governed contract")
    confidence_text = policy["confidenceThresholdDecimal"]
    deadband_text = policy["deadbandBpsDecimal"]
    if not isinstance(confidence_text, str) or not re.fullmatch(
        r"(?:0|[1-9]\d*)(?:\.\d*[1-9])?", confidence_text
    ):
        raise ValueError("Pre-evaluation confidence threshold is not canonical")
    confidence = Decimal(confidence_text)
    if not Decimal("0.5") <= confidence <= Decimal("1"):
        raise ValueError("Pre-evaluation confidence threshold is out of range")
    if deadband_text != canonical_decimal_string(DEFAULT_DEADBAND_BPS):
        raise ValueError("Pre-evaluation deadband does not match the governed value")
    preimages = (
        ("targetJsonPreimage", "targetSha256", 32_768),
        ("fitStateJsonPreimage", "fitStateSha256", 1_048_576),
        ("samplingJsonPreimage", "samplingSha256", 262_144),
    )
    for preimage_name, digest_name, maximum_length in preimages:
        preimage = policy[preimage_name]
        digest = policy[digest_name]
        if (
            not isinstance(preimage, str)
            or len(preimage) < 2
            or len(preimage) > maximum_length
            or not preimage.isascii()
        ):
            raise ValueError(f"Pre-evaluation {preimage_name} is invalid")
        parse_canonical_preimage_object(preimage, preimage_name)
        expected_digest = hashlib.sha256(preimage.encode("utf-8")).hexdigest()
        if digest != expected_digest:
            raise ValueError(f"Pre-evaluation {digest_name} does not match its preimage")


def canonical_decimal_string(value: float) -> str:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Canonical decimal values must be finite")
    decimal_value = Decimal(str(number))
    if decimal_value == 0:
        return "0"
    result = format(decimal_value, "f")
    if "." in result:
        result = result.rstrip("0").rstrip(".")
    return result


def canonical_preimage_json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def parse_canonical_preimage_object(text: str, label: str) -> dict[str, object]:
    def reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"Pre-evaluation {label} contains duplicate key {key!r}")
            result[key] = value
        return result

    def reject_nonfinite_constant(value: str) -> object:
        raise ValueError(
            f"Pre-evaluation {label} contains non-finite JSON constant {value}"
        )

    try:
        value = json.loads(
            text,
            object_pairs_hook=reject_duplicate_keys,
            parse_constant=reject_nonfinite_constant,
        )
    except (json.JSONDecodeError, ValueError) as error:
        raise ValueError(f"Pre-evaluation {label} is not strict JSON") from error
    if not isinstance(value, dict):
        raise ValueError(f"Pre-evaluation {label} must have a JSON object root")
    if canonical_preimage_json(value) != text:
        raise ValueError(f"Pre-evaluation {label} is not canonically encoded")
    return value


def canonical_policy_json(value: object) -> str:
    def normalize(candidate: object, path: str) -> object:
        if isinstance(candidate, str):
            if not candidate.isascii():
                raise ValueError(
                    f"Pre-evaluation policy strings must be ASCII at {path}"
                )
            return candidate
        if isinstance(candidate, list):
            return [
                normalize(item, f"{path}[{index}]")
                for index, item in enumerate(candidate)
            ]
        if isinstance(candidate, dict):
            normalized: dict[str, object] = {}
            keys = list(candidate)
            if any(not isinstance(key, str) or not key.isascii() for key in keys):
                raise ValueError(
                    f"Pre-evaluation policy keys must be ASCII strings at {path}"
                )
            for key in sorted(keys):
                normalized[key] = normalize(candidate[key], f"{path}.{key}")
            return normalized
        raise ValueError(
            "Pre-evaluation policy canonical values must contain only "
            f"objects, arrays, and ASCII strings; found {type(candidate).__name__} at {path}"
        )

    normalized = normalize(value, "$")
    return json.dumps(
        normalized,
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def row_abstention_reason(
    row: dict[str, object],
    feature_names: Sequence[str],
    ood_envelope: dict[str, object],
    *,
    require_cross_venue_guard: bool,
) -> str | None:
    if row.get("sourceIntegrityHealthy") is not True:
        return "SOURCE_INTEGRITY_UNHEALTHY"
    if require_cross_venue_guard and row.get("crossVenueGuardAvailability") != "AVAILABLE_HEALTHY":
        return "CROSS_VENUE_GUARD_UNAVAILABLE"
    features = row.get("features")
    if not isinstance(features, dict):
        return "MISSING_FEATURE"
    raw_bounds = ood_envelope.get("rawBounds")
    if not isinstance(raw_bounds, dict):
        raise ValueError("Replay OOD envelope is missing raw bounds")
    lower = raw_bounds.get("lower")
    upper = raw_bounds.get("upper")
    if not isinstance(lower, list) or not isinstance(upper, list) or not (
        len(lower) == len(upper) == len(feature_names)
    ):
        raise ValueError("Replay OOD envelope dimensions do not match features")
    for index, name in enumerate(feature_names):
        raw = features.get(name)
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            return "MISSING_FEATURE"
        value = float(raw)
        if not math.isfinite(value):
            return "NON_FINITE_FEATURE"
        if value < float(lower[index]) or value > float(upper[index]):
            return "OUT_OF_DISTRIBUTION"
    return None


def direction_eligible(
    row: dict[str, object], probabilities: np.ndarray
) -> tuple[bool, int]:
    selected_index = int(np.argmax(probabilities))
    if selected_index == CLASS_ORDER.index("AT_OPEN"):
        return False, selected_index
    relation = CLASS_ORDER[selected_index]
    current_relation = str(row["currentRelation"])
    reversal = (
        (current_relation == "ABOVE_OPEN" and relation == "BELOW_OPEN")
        or (current_relation == "BELOW_OPEN" and relation == "ABOVE_OPEN")
    )
    eligible = bool(row["candidateEligible"])
    if str(row["signalType"]).endswith("REVERSAL"):
        eligible = eligible and reversal
    return eligible, selected_index


def replay_policy(
    rows: Sequence[dict[str, object]],
    probabilities: np.ndarray,
    confidence_threshold: float,
    *,
    feature_names: Sequence[str],
    ood_envelope: dict[str, object],
    require_cross_venue_guard: bool,
    scope: str,
) -> dict[str, object]:
    if len(rows) != len(probabilities) or not np.all(np.isfinite(probabilities)):
        raise ValueError("Replay rows and finite probabilities must align")
    alerts: list[dict[str, object]] = []
    abstentions: dict[str, int] = {}
    by_window: dict[str, list[int]] = {}
    for index, row in enumerate(rows):
        by_window.setdefault(str(row["windowStart"]), []).append(index)
    window_starts = list(by_window)
    for window_index, (window_start, indices) in enumerate(by_window.items()):
        for index in indices:
            row = rows[index]
            reason = row_abstention_reason(
                row,
                feature_names,
                ood_envelope,
                require_cross_venue_guard=require_cross_venue_guard,
            )
            if reason is not None:
                abstentions[reason] = abstentions.get(reason, 0) + 1
                continue
            eligible, selected_index = direction_eligible(row, probabilities[index])
            if selected_index == CLASS_ORDER.index("AT_OPEN"):
                abstentions["FLAT_MODEL_OUTCOME"] = abstentions.get("FLAT_MODEL_OUTCOME", 0) + 1
                continue
            probability = float(probabilities[index, selected_index])
            relation = CLASS_ORDER[selected_index]
            if eligible and probability >= confidence_threshold:
                alerts.append({
                    'windowStart': window_start,
                    "rowIndex": index,
                    "windowIndex": window_index,
                    "probability": probability,
                    "predicted": relation,
                    "actual": str(row["label"]),
                    "leadTimeSeconds": float(row["features"]["remaining_ratio"])
                    * int(row["durationSeconds"]),
                })
                break
            reason = "BELOW_CONFIDENCE_THRESHOLD" if eligible else "SIGNAL_RULE_INELIGIBLE"
            abstentions[reason] = abstentions.get(reason, 0) + 1
    correct = sum(alert["predicted"] == alert["actual"] for alert in alerts)
    flat = sum(alert["actual"] == "AT_OPEN" for alert in alerts)
    by_direction = {
        relation: {
            "alertCount": sum(alert["predicted"] == relation for alert in alerts),
            "correctCount": sum(
                alert["predicted"] == relation and alert["actual"] == relation for alert in alerts
            ),
        }
        for relation in CLASS_ORDER[:2]
    }
    for metrics in by_direction.values():
        metrics["precision"] = (
            metrics["correctCount"] / metrics["alertCount"] if metrics["alertCount"] else None
        )
        metrics["coverage"] = metrics["alertCount"] / len(by_window) if by_window else 0.0
    bootstrap = block_bootstrap_policy(alerts, window_starts)
    lead_times = [float(alert["leadTimeSeconds"]) for alert in alerts]
    result = {
        "scope": scope,
        "windowCount": len(by_window),
        "alertCount": len(alerts),
        "coverage": len(alerts) / len(by_window) if by_window else 0.0,
        "precision": correct / len(alerts) if alerts else None,
        "flatAlertCount": flat,
        "emittedRowIndices": [int(alert["rowIndex"]) for alert in alerts],
        "abstentionRowCounts": abstentions,
        "crossVenueGuardRequired": require_cross_venue_guard,
        "perDirection": by_direction,
        "leadTimeSeconds": {
            "minimum": min(lead_times) if lead_times else None,
            "median": float(np.median(lead_times)) if lead_times else None,
            "maximum": max(lead_times) if lead_times else None,
        },
        "precisionCi95": bootstrap["precisionCi95"],
        "coverageCi95": bootstrap["coverageCi95"],
        "threshold": confidence_threshold,
        "oneAlertPerWindow": True,
    }
    result['dependenceAwareUncertainty'] = bootstrap
    return result


def block_bootstrap_policy(
    alerts: Sequence[dict[str, object]],
    window_starts: Sequence[str],
    *,
    seed: int = 20260812,
) -> dict[str, object]:
    window_count = len(window_starts)
    direction_counts = {
        relation: sum(alert['predicted'] == relation for alert in alerts)
        for relation in CLASS_ORDER[:2]
    }
    parsed_window_starts: list[datetime] = []
    previous_window: datetime | None = None
    for raw_window_start in window_starts:
        window_start = parse_timestamp(str(raw_window_start))
        if format_timestamp(window_start) != raw_window_start:
            raise ValueError('Policy bootstrap window starts must be canonical UTC timestamps')
        if previous_window is not None and window_start <= previous_window:
            raise ValueError('Policy bootstrap window starts must be unique and chronological')
        parsed_window_starts.append(window_start)
        previous_window = window_start

    if parsed_window_starts:
        first_day = parsed_window_starts[0].date()
        last_day = parsed_window_starts[-1].date()
        calendar_day_count = (last_day - first_day).days + 1
    else:
        first_day = None
        calendar_day_count = 0
    windows_by_day = np.zeros(calendar_day_count, dtype=float)
    alerts_by_day = np.zeros(calendar_day_count, dtype=float)
    correct_by_day = np.zeros(calendar_day_count, dtype=float)
    day_index_by_window: dict[str, int] = {}
    for window_start in parsed_window_starts:
        if first_day is None:
            raise AssertionError('A parsed window requires a first UTC day')
        day_index = (window_start.date() - first_day).days
        canonical_start = format_timestamp(window_start)
        day_index_by_window[canonical_start] = day_index
        windows_by_day[day_index] += 1

    alerted_windows: set[str] = set()
    for alert in alerts:
        alert_window = str(alert.get('windowStart', ''))
        if alert_window not in day_index_by_window:
            raise ValueError('Policy bootstrap alert does not bind to an evaluated window')
        if alert_window in alerted_windows:
            raise ValueError('Policy bootstrap received more than one alert for a window')
        alerted_windows.add(alert_window)
        day_index = day_index_by_window[alert_window]
        alerts_by_day[day_index] += 1
        correct_by_day[day_index] += float(alert['predicted'] == alert['actual'])

    observed_day_count = int(np.count_nonzero(windows_by_day))
    block_length_days = 7
    metadata = {
        'method': 'MOVING_BLOCK_BOOTSTRAP_CONTIGUOUS_UTC_DAYS',
        'timeUnit': 'UTC_DAY',
        'blockLengthDays': block_length_days,
        'calendarDayCount': calendar_day_count,
        'observedCalendarDayCount': observed_day_count,
        'missingCalendarDayCount': calendar_day_count - observed_day_count,
        'effectiveUniqueWindowCount': window_count,
        'independentBlockCount': calendar_day_count // block_length_days,
        'seed': seed,
        'resamples': 1_000,
    }
    if (
        window_count < 100
        or len(alerts) < 30
        or min(direction_counts.values(), default=0) < 10
        or observed_day_count < 20
        or calendar_day_count < 28
    ):
        return {
            **metadata,
            'supportStatus': 'INSUFFICIENT_SUPPORT',
            'reason': (
                'At least 100 windows, 30 alerts, 10 alerts per direction, '
                '20 observed UTC days, and a 28-day calendar span are required'
            ),
            'precisionCi95': None,
            'coverageCi95': None,
        }

    random = np.random.default_rng(seed)
    precisions: list[float] = []
    coverages: list[float] = []
    for _ in range(1_000):
        sampled_days: list[int] = []
        while len(sampled_days) < calendar_day_count:
            start = int(
                random.integers(0, calendar_day_count - block_length_days + 1)
            )
            sampled_days.extend(
                start + offset for offset in range(block_length_days)
            )
        indices = np.asarray(sampled_days[:calendar_day_count], dtype=int)
        sampled_windows = float(np.sum(windows_by_day[indices]))
        if sampled_windows <= 0:
            continue
        sampled_alerts = float(np.sum(alerts_by_day[indices]))
        coverages.append(sampled_alerts / sampled_windows)
        if sampled_alerts > 0:
            precisions.append(float(np.sum(correct_by_day[indices])) / sampled_alerts)
    if not precisions or not coverages:
        return {
            **metadata,
            'supportStatus': 'INSUFFICIENT_SUPPORT',
            'reason': 'Calendar block resamples did not retain measurable support',
            'precisionCi95': None,
            'coverageCi95': None,
        }
    return {
        **metadata,
        'supportStatus': 'SUFFICIENT',
        'precisionCi95': [
            float(value) for value in np.quantile(precisions, (0.025, 0.975))
        ],
        'coverageCi95': [
            float(value) for value in np.quantile(coverages, (0.025, 0.975))
        ],
    }


def calibration_population_report(
    rows: Sequence[dict[str, object]],
    probabilities: np.ndarray,
    expected: np.ndarray,
    indices: Sequence[int],
    *,
    population: str,
    minimum_windows: int,
) -> dict[str, object]:
    selected = np.asarray(indices, dtype=int)
    selected_rows = [rows[int(index)] for index in selected]
    windows = {str(row["windowStart"]) for row in selected_rows}
    days = {str(row["windowStart"])[:10] for row in selected_rows}
    if len(selected) == 0:
        return {
            "population": population,
            "supportStatus": "INSUFFICIENT_SUPPORT",
            "reason": "No rows entered this decision population",
            "rowCount": 0,
            "uniqueWindowCount": 0,
            "uniqueDayCount": 0,
            "metrics": None,
        }
    predictions = np.argmax(probabilities[selected], axis=1)
    direction_counts = {
        relation: int(np.sum(predictions == index))
        for index, relation in enumerate(CLASS_ORDER[:2])
    }
    sufficient = len(windows) >= minimum_windows and all(
        count >= 10 for count in direction_counts.values()
    )
    return {
        "population": population,
        "supportStatus": "SUFFICIENT" if sufficient else "INSUFFICIENT_SUPPORT",
        "reason": None if sufficient else (
            f"At least {minimum_windows} windows and 10 predictions per direction are required"
        ),
        "rowCount": len(selected_rows),
        "uniqueWindowCount": len(windows),
        "uniqueDayCount": len(days),
        "predictedDirectionCounts": direction_counts,
        "metrics": evaluate_probabilities(
            probabilities[selected],
            expected[selected],
            window_balanced_weights(selected_rows),
        ),
    }


def partition_summary(*partitions: Sequence[dict[str, object]]) -> dict[str, object]:
    names = ("train", "calibration", "holdout")
    return {
        name: {
            "count": len(rows),
            "independentWindowCount": len({str(row["windowStart"]) for row in rows}),
            "independentDayCount": len({str(row["windowStart"])[:10] for row in rows}),
            "startAt": str(rows[0]["decisionAt"]),
            "endAt": str(rows[-1]["decisionAt"]),
            "classCounts": {label: sum(row["label"] == label for row in rows) for label in CLASS_ORDER},
        }
        for name, rows in zip(names, partitions)
    }


def dataset_manifest_summary(
    manifest: dict[str, object], dataset_sha256: str, manifest_sha256: str
) -> dict[str, object]:
    source_manifest = manifest["source"]
    archives = source_manifest["archives"]
    archive_index = [
        {
            "day": archive["day"],
            "archiveName": archive["archive"],
            "archiveBytes": archive["archive_bytes"],
            "archiveSha256": archive["archive_sha256"],
            "checksumName": archive["checksum_name"],
            "checksumBytes": archive["checksum_bytes"],
            "checksumSha256": archive["checksum_sha256"],
            "expectedArchiveSha256": archive["expected_sha256"],
            "member": archive["member"],
            "acceptedTradeCount": archive["accepted_trade_count"],
            "firstEventAt": archive["first_event_at"],
            "lastEventAt": archive["last_event_at"],
            "firstTradeId": archive["first_trade_id"],
            "lastTradeId": archive["last_trade_id"],
        }
        for archive in archives
    ]
    reject_log = [
        {"archive": archive["archive"], "rejectedTradeCount": archive["rejected_trade_count"]}
        for archive in archives
    ]
    lineage_kind = source_manifest["lineageKind"]
    is_public = lineage_kind == "PUBLIC_BINANCE_ARCHIVE"
    acquisition = source_manifest["acquisitionEvidence"]
    source_name = {
        "PUBLIC_BINANCE_ARCHIVE": "BINANCE_DATA_VISION",
        "LOCAL_ARCHIVE_REPLAY": "LOCAL_ARCHIVE_REPLAY",
        "SYNTHETIC_LOCAL": "SYNTHETIC_LOCAL",
    }[lineage_kind]
    return {
        "schemaVersion": DATASET_MANIFEST_SUMMARY_SCHEMA_VERSION,
        "datasetContentSha256": dataset_sha256,
        "datasetManifestSha256": manifest_sha256,
        "symbol": SUPPORTED_SYMBOL,
        "lineageKind": lineage_kind,
        "source": source_name,
        "dataKind": "TRADES",
        "targetVersion": LABEL_POLICY_VERSION,
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "deadbandBps": manifest["target"]["deadbandBps"],
        "startAt": manifest["startAt"],
        "endAt": manifest["endAt"],
        "archiveCount": len(archives),
        "archiveChecksumsVerified": is_public,
        "officialTransportEvidenceVerified": is_public,
        "preparedArchiveIndexSha256": hashlib.sha256(
            canonical_json(archive_index).encode()
        ).hexdigest(),
        "acquisitionArchiveIndexSha256": (
            acquisition["acquisitionArchiveIndexSha256"] if is_public else None
        ),
        "acquisitionManifestSha256": (
            acquisition["acquisitionManifestSha256"] if is_public else None
        ),
        "rejectLogSha256": hashlib.sha256(canonical_json(reject_log).encode()).hexdigest(),
        "crossVenueGuardAvailability": "UNAVAILABLE",
        "productionEligible": False,
        "acceptedTradeCount": manifest["acceptedTradeCount"],
        "rejectedTradeCount": manifest["rejectedTradeCount"],
        "gapCount": manifest["gapCount"],
        "duplicateTradeCount": manifest["duplicateTradeCount"],
        "preparedDecisionRowCount": manifest["preparedDecisionRowCount"],
        "preparedWindowCount": manifest["preparedWindowCount"],
        "windowCountUnit": manifest["windowCountUnit"],
        "sourceIntegrityRequired": True,
        "sourceStartDateInclusive": source_manifest["startDateInclusive"],
        "sourceEndDateExclusive": source_manifest["endDateExclusive"],
        "sourceDayCount": source_manifest["dayCount"],
        "partitionWindowCounts": manifest["partitionWindowCounts"],
        "candidateSchedule": manifest["target"]["candidateSchedule"],
    }


def fit_ood_envelope(
    rows: Sequence[dict[str, object]],
    names: Sequence[str],
    means: np.ndarray,
    scales: np.ndarray,
    fitted_through: str,
) -> dict[str, object]:
    raw = np.asarray([[float(row["features"][name]) for name in names] for row in rows])
    normalized = (raw - means) / scales
    lower_quantile = 0.005
    upper_quantile = 0.995
    return {
        "schemaVersion": "flippars.fit-support-envelope/1",
        "version": "fit-quantile-box.1",
        "method": "FIT_PARTITION_QUANTILE_BOX",
        "fittedPartition": "MODEL_FIT",
        "fittedThrough": fitted_through,
        "lowerQuantile": lower_quantile,
        "upperQuantile": upper_quantile,
        "featureNames": list(names),
        "rawBounds": {
            "lower": np.quantile(raw, lower_quantile, axis=0).tolist(),
            "upper": np.quantile(raw, upper_quantile, axis=0).tolist(),
        },
        "normalizedBounds": {
            "lower": np.quantile(normalized, lower_quantile, axis=0).tolist(),
            "upper": np.quantile(normalized, upper_quantile, axis=0).tolist(),
        },
        "missingValuePolicy": "ABSTAIN",
        "nonFiniteValuePolicy": "ABSTAIN",
        "breachPolicy": "ABSTAIN",
    }


def target_contract(signal_type: str, deadband_bps: float) -> dict[str, object]:
    duration_seconds = SIGNAL_DURATION_SECONDS[signal_type]
    phase_start = 450 if signal_type == "FIFTEEN_MINUTE_REVERSAL" else 0
    phase_end = 60 if signal_type == "FIVE_MINUTE_EARLY_DIRECTION" else duration_seconds
    first_offset = 450 if signal_type == "FIFTEEN_MINUTE_REVERSAL" else DEFAULT_DECISION_CADENCE_SECONDS
    return {
        "kind": "BINANCE_SPOT_CANDLE_CLOSE_RELATION",
        "targetVersion": LABEL_POLICY_VERSION,
        "venue": "BINANCE",
        "marketType": "SPOT",
        "symbol": SUPPORTED_SYMBOL,
        "quoteAsset": "USDT",
        "input": "TRADE",
        "timeBasis": "EVENT_TIME",
        "tradeOrdering": "EVENT_TIME_THEN_TRADE_ID",
        "windowAlignment": "UTC_EPOCH",
        "windowBounds": "HALF_OPEN",
        "durationSeconds": duration_seconds,
        "openDefinition": "FIRST_TRADE_AT_OR_AFTER_WINDOW_START",
        "closeDefinition": "LAST_TRADE_BEFORE_WINDOW_END",
        "targetPriceNormalization": "NONE",
        "classOrder": list(CLASS_ORDER),
        "deadbandBps": deadband_bps,
        "labelPolicyVersion": LABEL_POLICY_VERSION,
        "decisionPolicyVersion": DECISION_POLICY_VERSION,
        "crossVenueGuardPolicyVersion": CROSS_VENUE_GUARD_POLICY_VERSION,
        "signalType": signal_type,
        "candidateSchedule": {
            "schemaVersion": "flippars.candidate-decision-schedule/1",
            "kind": "FIXED_CADENCE",
            "firstDecisionOffsetSeconds": first_offset,
            "cadenceSeconds": DEFAULT_DECISION_CADENCE_SECONDS,
            "phaseStartSeconds": phase_start,
            "phaseEndExclusiveSeconds": phase_end,
            "lastDecisionOffsetSeconds": (
                45 if signal_type == "FIVE_MINUTE_EARLY_DIRECTION"
                else duration_seconds - SIGNAL_MINIMUM_LEAD_TIME_SECONDS[signal_type]
            ),
            "minimumLeadTimeSeconds": SIGNAL_MINIMUM_LEAD_TIME_SECONDS[signal_type],
            "selectionPolicy": "FIRST_QUALIFIED_PER_WINDOW",
        },
    }


def target_contract_for_options(options: DatasetOptions) -> dict[str, object]:
    target = target_contract(options.signal_type, options.deadband_bps)
    schedule = target["candidateSchedule"]
    schedule["cadenceSeconds"] = options.decision_cadence_seconds
    schedule["minimumLeadTimeSeconds"] = options.minimum_lead_time_seconds
    schedule["firstDecisionOffsetSeconds"] = (
        450 if options.signal_type == "FIFTEEN_MINUTE_REVERSAL"
        else options.decision_cadence_seconds
    )
    schedule["lastDecisionOffsetSeconds"] = (
        45 if options.signal_type == "FIVE_MINUTE_EARLY_DIRECTION"
        else SIGNAL_DURATION_SECONDS[options.signal_type] - options.minimum_lead_time_seconds
    )
    return target


def validate_candidate_artifact(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or value.get("schemaVersion") != ARTIFACT_SCHEMA_VERSION:
        raise ValueError("Artifact is not a supported gap-aware draft candidate")
    required = {
        "schemaVersion", "artifactId", "version", "status", "signalType", "target", "createdAt",
        "modelFitThrough", "calibrationFitThrough", "evaluationThrough", "featureSchemaVersion",
        "featureNames", "normalization", "ood", "model", "calibration",
        "datasetContentSha256", "datasetManifestSha256", "datasetManifest",
        "preEvaluationPolicySha256", "trainingCodeSha256", "approval",
    }
    if set(value) != required or value["status"] != "DRAFT":
        raise ValueError("Artifact has an unexpected top-level schema")
    if not IDENTIFIER_PATTERN.fullmatch(str(value["artifactId"])):
        raise ValueError("Artifact ID does not satisfy IdentifierSchema")
    if not VERSION_PATTERN.fullmatch(str(value["version"])):
        raise ValueError("Artifact version does not satisfy VersionSchema")
    if (
        value["signalType"] not in SIGNAL_TYPES
        or value["featureSchemaVersion"] != FEATURE_SCHEMA_VERSION
    ):
        raise ValueError("Artifact signal or feature version is invalid")
    if value["featureNames"] != list(FEATURE_NAMES):
        raise ValueError("Artifact feature schema is invalid")
    target = value["target"]
    schedule = target.get("candidateSchedule") if isinstance(target, dict) else None
    if not isinstance(schedule, dict):
        raise ValueError("Artifact candidate schedule is missing")
    expected_target = target_contract_for_options(
        DatasetOptions(
            signal_type=str(value["signalType"]),
            deadband_bps=float(target["deadbandBps"]),
            timeframe_minutes=SIGNAL_DURATION_SECONDS[str(value["signalType"])] // 60,
            decision_cadence_seconds=int(schedule["cadenceSeconds"]),
            minimum_lead_time_seconds=int(schedule["minimumLeadTimeSeconds"]),
        )
    )
    if target != expected_target:
        raise ValueError("Artifact target contract is invalid")
    count = len(FEATURE_NAMES)
    normalization = value["normalization"]
    model = value["model"]
    calibration = value["calibration"]
    if not isinstance(normalization, dict) or set(normalization) != {"means", "scales"}:
        raise ValueError("Artifact normalization schema is invalid")
    if not isinstance(model, dict) or set(model) != {"kind", "weights", "biases"}:
        raise ValueError("Artifact model schema is invalid")
    if model.get("kind") != "MULTINOMIAL_LOGISTIC":
        raise ValueError("Artifact model kind is invalid")
    if (
        not isinstance(calibration, dict)
        or set(calibration) != {"method", "temperature", "version", "validUntil"}
        or calibration.get("method") != "TEMPERATURE"
        or not VERSION_PATTERN.fullmatch(str(calibration.get("version", "")))
    ):
        raise ValueError("Artifact calibration schema is invalid")
    temperature = finite_float(calibration["temperature"], "calibration temperature")
    if temperature <= 0 or temperature > 1_000_000:
        raise ValueError("Artifact calibration temperature is invalid")
    if value.get("approval") != {"approvedAt": None, "approvedBy": None}:
        raise ValueError("Draft artifact approval boundary is invalid")
    if len(normalization["means"]) != count or len(normalization["scales"]) != count:
        raise ValueError("Artifact normalization dimensions are invalid")
    means = [finite_float(item, "normalization mean") for item in normalization["means"]]
    scales = [finite_float(item, "normalization scale") for item in normalization["scales"]]
    if any(scale <= 0 for scale in scales):
        raise ValueError("Artifact normalization scales must be positive")
    if (
        not isinstance(model["weights"], list)
        or len(model["weights"]) != 3
        or any(not isinstance(weights, list) or len(weights) != count for weights in model["weights"])
        or not isinstance(model["biases"], list)
        or len(model["biases"]) != 3
    ):
        raise ValueError("Artifact model dimensions are invalid")
    for weights in model["weights"]:
        for weight in weights:
            finite_float(weight, "model weight")
    for bias in model["biases"]:
        finite_float(bias, "model bias")
    for hash_name in (
        "datasetContentSha256",
        "datasetManifestSha256",
        "preEvaluationPolicySha256",
        "trainingCodeSha256",
    ):
        if not re.fullmatch(r"[a-f0-9]{64}", str(value[hash_name])):
            raise ValueError(f"Artifact {hash_name} is not a lowercase SHA-256 digest")
    summary = value["datasetManifest"]
    summary_required = {
        "schemaVersion", "datasetContentSha256", "datasetManifestSha256",
        "lineageKind", "preparedArchiveIndexSha256", "acquisitionArchiveIndexSha256",
        "acquisitionManifestSha256", "rejectLogSha256", "source", "dataKind", "symbol",
        "targetVersion", "featureSchemaVersion", "deadbandBps", "candidateSchedule",
        "windowCountUnit", "sourceIntegrityRequired", "crossVenueGuardAvailability",
        "productionEligible", "archiveCount", "archiveChecksumsVerified",
        "officialTransportEvidenceVerified", "sourceStartDateInclusive",
        "sourceEndDateExclusive", "sourceDayCount", "startAt",
        "endAt", "acceptedTradeCount", "rejectedTradeCount", "gapCount",
        "duplicateTradeCount", "preparedWindowCount", "preparedDecisionRowCount",
        "partitionWindowCounts",
    }
    if not isinstance(summary, dict) or set(summary) != summary_required:
        raise ValueError("Artifact dataset manifest summary schema is invalid")
    lineage_sources = {
        "PUBLIC_BINANCE_ARCHIVE": "BINANCE_DATA_VISION",
        "LOCAL_ARCHIVE_REPLAY": "LOCAL_ARCHIVE_REPLAY",
        "SYNTHETIC_LOCAL": "SYNTHETIC_LOCAL",
    }
    if (
        summary["schemaVersion"] != DATASET_MANIFEST_SUMMARY_SCHEMA_VERSION
        or summary["lineageKind"] not in lineage_sources
        or summary["source"] != lineage_sources.get(summary["lineageKind"])
        or summary["dataKind"] != "TRADES"
        or summary["symbol"] != SUPPORTED_SYMBOL
        or summary["targetVersion"] != LABEL_POLICY_VERSION
        or summary["featureSchemaVersion"] != FEATURE_SCHEMA_VERSION
        or summary["windowCountUnit"] != "UNIQUE_WINDOW_START"
        or summary["sourceIntegrityRequired"] is not True
        or summary["crossVenueGuardAvailability"] != "UNAVAILABLE"
        or summary["productionEligible"] is not False
    ):
        raise ValueError("Artifact dataset manifest summary contract is invalid")
    for hash_name in (
        "datasetContentSha256", "datasetManifestSha256",
        "preparedArchiveIndexSha256", "rejectLogSha256"
    ):
        if not is_sha256_hex(summary[hash_name]):
            raise ValueError(f"Dataset summary {hash_name} is invalid")
    is_public = summary["lineageKind"] == "PUBLIC_BINANCE_ARCHIVE"
    if is_public:
        if (
            summary["archiveChecksumsVerified"] is not True
            or summary["officialTransportEvidenceVerified"] is not True
            or not is_sha256_hex(summary["acquisitionArchiveIndexSha256"])
            or not is_sha256_hex(summary["acquisitionManifestSha256"])
        ):
            raise ValueError("Public dataset summary lacks official acquisition evidence")
    elif (
        summary["archiveChecksumsVerified"] is not False
        or summary["officialTransportEvidenceVerified"] is not False
        or summary["acquisitionArchiveIndexSha256"] is not None
        or summary["acquisitionManifestSha256"] is not None
    ):
        raise ValueError("Non-public dataset summary cannot claim official acquisition evidence")
    for count_name in (
        "archiveCount", "sourceDayCount", "acceptedTradeCount", "rejectedTradeCount", "gapCount",
        "duplicateTradeCount", "preparedWindowCount", "preparedDecisionRowCount",
    ):
        count_value = summary[count_name]
        if isinstance(count_value, bool) or not isinstance(count_value, int) or count_value < 0:
            raise ValueError(f"Dataset summary {count_name} is invalid")
    if summary["archiveCount"] != summary["sourceDayCount"]:
        raise ValueError("Dataset summary source day count must match its archive count")
    if summary["archiveCount"] > 0:
        for name in ("sourceStartDateInclusive", "sourceEndDateExclusive"):
            if not isinstance(summary[name], str) or not re.fullmatch(
                r"\d{4}-\d{2}-\d{2}", summary[name]
            ):
                raise ValueError(f"Dataset summary {name} is invalid")
        source_start_date = date.fromisoformat(summary["sourceStartDateInclusive"])
        source_end_date = date.fromisoformat(summary["sourceEndDateExclusive"])
        if (source_end_date - source_start_date).days != summary["sourceDayCount"]:
            raise ValueError("Dataset summary source range does not match its day count")
    elif (
        summary["sourceStartDateInclusive"] is not None
        or summary["sourceEndDateExclusive"] is not None
    ):
        raise ValueError("Archive-free dataset summary cannot claim a source date range")
    if summary["preparedDecisionRowCount"] < summary["preparedWindowCount"]:
        raise ValueError("Dataset summary row count cannot be below its window count")
    partition_counts = summary["partitionWindowCounts"]
    if (
        not isinstance(partition_counts, dict)
        or set(partition_counts) != {"modelFit", "calibration", "evaluation"}
        or any(isinstance(item, bool) or not isinstance(item, int) or item < 0 for item in partition_counts.values())
        or sum(partition_counts.values()) != summary["preparedWindowCount"]
    ):
        raise ValueError("Dataset summary partition counts are invalid")
    if (
        value["datasetContentSha256"] != summary["datasetContentSha256"]
        or value["datasetManifestSha256"] != summary["datasetManifestSha256"]
    ):
        raise ValueError("Artifact dataset hashes disagree")
    if value["target"]["deadbandBps"] != summary["deadbandBps"]:
        raise ValueError("Artifact deadband and dataset manifest disagree")
    if (
        summary["candidateSchedule"] != target["candidateSchedule"]
        or summary["targetVersion"] != target["targetVersion"]
        or summary["featureSchemaVersion"] != value["featureSchemaVersion"]
    ):
        raise ValueError("Artifact target and dataset summary are incompatible")
    ood = value["ood"]
    ood_required = {
        "schemaVersion", "version", "method", "fittedPartition", "fittedThrough",
        "lowerQuantile", "upperQuantile", "featureNames", "rawBounds",
        "normalizedBounds", "missingValuePolicy", "nonFiniteValuePolicy", "breachPolicy",
    }
    if (
        not isinstance(ood, dict)
        or set(ood) != ood_required
        or ood.get("schemaVersion") != "flippars.fit-support-envelope/1"
        or not VERSION_PATTERN.fullmatch(str(ood.get("version", "")))
        or ood.get("method") != "FIT_PARTITION_QUANTILE_BOX"
        or ood.get("fittedPartition") != "MODEL_FIT"
        or ood.get("fittedThrough") != value["modelFitThrough"]
        or ood.get("featureNames") != list(FEATURE_NAMES)
    ):
        raise ValueError("Artifact OOD envelope is invalid")
    lower_quantile = finite_float(ood["lowerQuantile"], "OOD lower quantile")
    upper_quantile = finite_float(ood["upperQuantile"], "OOD upper quantile")
    if not 0 <= lower_quantile <= 0.5 or not 0.5 <= upper_quantile <= 1 or lower_quantile >= upper_quantile:
        raise ValueError("Artifact OOD quantiles are invalid")
    for policy in ("missingValuePolicy", "nonFiniteValuePolicy", "breachPolicy"):
        if ood.get(policy) != "ABSTAIN":
            raise ValueError("Artifact OOD policy must abstain")
    for bounds_name in ("rawBounds", "normalizedBounds"):
        bounds = ood.get(bounds_name)
        if not isinstance(bounds, dict) or set(bounds) != {"lower", "upper"}:
            raise ValueError("Artifact OOD bounds are invalid")
        if any(not isinstance(bounds[edge], list) or len(bounds[edge]) != count for edge in ("lower", "upper")):
            raise ValueError("Artifact OOD bound dimensions are invalid")
    raw_bounds = ood["rawBounds"]
    normalized_bounds = ood["normalizedBounds"]
    for index in range(count):
        raw_lower = finite_float(raw_bounds["lower"][index], "OOD raw lower bound")
        raw_upper = finite_float(raw_bounds["upper"][index], "OOD raw upper bound")
        normalized_lower = finite_float(
            normalized_bounds["lower"][index], "OOD normalized lower bound"
        )
        normalized_upper = finite_float(
            normalized_bounds["upper"][index], "OOD normalized upper bound"
        )
        if raw_lower > raw_upper or normalized_lower > normalized_upper:
            raise ValueError("Artifact OOD lower bound exceeds its upper bound")
        expected_lower = (raw_lower - means[index]) / scales[index]
        expected_upper = (raw_upper - means[index]) / scales[index]
        if not math.isclose(normalized_lower, expected_lower, rel_tol=1e-8, abs_tol=1e-8):
            raise ValueError("Artifact normalized OOD lower bound is invalid")
        if not math.isclose(normalized_upper, expected_upper, rel_tol=1e-8, abs_tol=1e-8):
            raise ValueError("Artifact normalized OOD upper bound is invalid")
    created_at = parse_timestamp(str(value["createdAt"]))
    model_fit_through = parse_timestamp(str(value["modelFitThrough"]))
    calibration_fit_through = parse_timestamp(str(value["calibrationFitThrough"]))
    evaluation_through = parse_timestamp(str(value["evaluationThrough"]))
    valid_until = parse_timestamp(str(calibration["validUntil"]))
    dataset_start = parse_timestamp(str(summary["startAt"]))
    dataset_end = parse_timestamp(str(summary["endAt"]))
    if not (
        dataset_start < model_fit_through < calibration_fit_through < evaluation_through
        and evaluation_through <= dataset_end <= created_at
        and valid_until > created_at
    ):
        raise ValueError("Artifact dataset and fit chronology is invalid")
    return value


def validate_dataset_manifest(value: object) -> dict[str, object]:
    required_top = {
        "schemaVersion",
        "datasetSchemaVersion",
        "createdAt",
        "symbol",
        "source",
        "target",
        "featureSchemaVersion",
        "featureNames",
        "sampling",
        "guard",
        "startAt",
        "endAt",
        "acceptedTradeCount",
        "rejectedTradeCount",
        "gapCount",
        "gapWindowStarts",
        "duplicateTradeCount",
        "preparedDecisionRowCount",
        "preparedWindowCount",
        "windowCountUnit",
        "partitionWindowCounts",
        "preparedDatasetSha256",
        "options",
        "generator",
    }
    if not isinstance(value, dict) or set(value) != required_top:
        raise ValueError("Dataset manifest has an unexpected root schema")
    if (
        value["schemaVersion"] != DATASET_MANIFEST_SCHEMA_VERSION
        or value["datasetSchemaVersion"] != DATASET_SCHEMA_VERSION
        or value["symbol"] != SUPPORTED_SYMBOL
        or value["featureSchemaVersion"] != FEATURE_SCHEMA_VERSION
        or value["featureNames"] != list(FEATURE_NAMES)
        or value["windowCountUnit"] != "UNIQUE_WINDOW_START"
        or not is_sha256_hex(value["preparedDatasetSha256"])
    ):
        raise ValueError("Dataset manifest version, symbol, feature, or digest contract mismatch")
    created_at = validate_canonical_timestamp(value["createdAt"], "createdAt")
    start_at = validate_canonical_timestamp(value["startAt"], "startAt")
    end_at = validate_canonical_timestamp(value["endAt"], "endAt")
    if not start_at < end_at <= created_at:
        raise ValueError("Dataset manifest chronology is invalid")

    options_value = value["options"]
    if not isinstance(options_value, dict) or set(options_value) != {
        "signal_type",
        "deadband_bps",
        "timeframe_minutes",
        "decision_cadence_seconds",
        "minimum_lead_time_seconds",
    }:
        raise ValueError("Dataset manifest options have an unexpected schema")
    for name in (
        "timeframe_minutes", "decision_cadence_seconds", "minimum_lead_time_seconds"
    ):
        if not is_positive_int(options_value[name]):
            raise ValueError(f"Dataset manifest option {name} must be a positive integer")
    if isinstance(options_value["deadband_bps"], bool):
        raise ValueError("Dataset manifest deadband cannot be boolean")
    options = DatasetOptions(
        signal_type=str(options_value["signal_type"]),
        deadband_bps=finite_float(options_value["deadband_bps"], "manifest deadband"),
        timeframe_minutes=int(options_value["timeframe_minutes"]),
        decision_cadence_seconds=int(options_value["decision_cadence_seconds"]),
        minimum_lead_time_seconds=int(options_value["minimum_lead_time_seconds"]),
    )
    validate_dataset_options(options)
    target = value["target"]
    if target != target_contract_for_options(options):
        raise ValueError("Dataset manifest target is not the governed contract")
    sampling = value["sampling"]
    if not isinstance(sampling, dict) or sampling != {
        "decisionPolicyVersion": DECISION_POLICY_VERSION,
        "decisionCadenceSeconds": options.decision_cadence_seconds,
        "minimumLeadTimeSeconds": options.minimum_lead_time_seconds,
        "featureCutoff": "EVENT_TIME_LT_DECISION_AT",
        "firstThresholdCrossingEvaluatedByReplay": True,
    }:
        raise ValueError("Dataset manifest sampling policy is invalid")
    if value["guard"] != {
        "sourceIntegrityRequired": True,
        "crossVenueGuardAvailability": "UNAVAILABLE",
        "productionEligible": False,
    }:
        raise ValueError("Dataset manifest guard boundary is invalid")
    generator = value["generator"]
    if not isinstance(generator, dict) or set(generator) != {
        "pythonVersion", "implementation", "platform", "packageVersion"
    }:
        raise ValueError("Dataset generator metadata has an unexpected schema")
    if any(not isinstance(generator[name], str) or not generator[name] for name in generator):
        raise ValueError("Dataset generator metadata must contain nonempty strings")
    if generator["packageVersion"] != "0.3.0":
        raise ValueError("Dataset generator package version is unsupported")

    count_names = (
        "acceptedTradeCount",
        "rejectedTradeCount",
        "gapCount",
        "duplicateTradeCount",
        "preparedDecisionRowCount",
        "preparedWindowCount",
    )
    for name in count_names:
        if not is_nonnegative_int(value[name]):
            raise ValueError(f"Dataset manifest has invalid {name}")
    if int(value["preparedWindowCount"]) < 1:
        raise ValueError("Dataset manifest must contain prepared windows")
    gap_starts = value["gapWindowStarts"]
    if not isinstance(gap_starts, list) or len(gap_starts) != int(value["gapCount"]):
        raise ValueError("Dataset manifest gap count does not match its window list")
    canonical_gaps = [
        format_timestamp(validate_canonical_timestamp(item, "gapWindowStarts"))
        for item in gap_starts
    ]
    if canonical_gaps != sorted(set(canonical_gaps)):
        raise ValueError(
            "Dataset manifest gaps must be canonical, strictly ordered, and unique"
        )
    if int(value["rejectedTradeCount"]) != 0 or int(value["duplicateTradeCount"]) != 0:
        raise ValueError("Governed training data must contain no rejected or duplicate trades")

    counts = value["partitionWindowCounts"]
    if not isinstance(counts, dict) or set(counts) != {
        "modelFit", "calibration", "evaluation"
    } or any(not is_nonnegative_int(count) for count in counts.values()):
        raise ValueError("Dataset manifest partition window counts are invalid")
    window_count = int(value["preparedWindowCount"])
    model_fit_end = int(window_count * 0.6)
    calibration_end = int(window_count * 0.8)
    expected_partition_counts = {
        "modelFit": model_fit_end,
        "calibration": calibration_end - model_fit_end,
        "evaluation": window_count - calibration_end,
    }
    if counts != expected_partition_counts:
        raise ValueError("Dataset manifest partition counts do not match the deterministic split")

    source = value["source"]
    if not isinstance(source, dict) or set(source) != {
        "lineageKind",
        "venue",
        "marketType",
        "input",
        "timeBasis",
        "startDateInclusive",
        "endDateExclusive",
        "dayCount",
        "acquisitionEvidence",
        "archives",
    }:
        raise ValueError("Dataset manifest source has an unexpected schema")
    lineage_kind = source["lineageKind"]
    if lineage_kind not in {
        "PUBLIC_BINANCE_ARCHIVE", "LOCAL_ARCHIVE_REPLAY", "SYNTHETIC_LOCAL"
    } or (
        source["venue"], source["marketType"], source["input"], source["timeBasis"]
    ) != ("BINANCE", "SPOT", "TRADE", "EVENT_TIME"):
        raise ValueError("Dataset manifest source identity is invalid")
    archives = source["archives"]
    if not isinstance(archives, list) or not is_nonnegative_int(source["dayCount"]):
        raise ValueError("Dataset manifest archive index is invalid")
    if len(archives) != int(source["dayCount"]):
        raise ValueError("Dataset manifest source day count does not match its archives")
    if bool(archives) != (source["startDateInclusive"] is not None):
        raise ValueError("Dataset manifest source range is incomplete")
    if bool(archives) != (source["endDateExclusive"] is not None):
        raise ValueError("Dataset manifest source range is incomplete")
    archive_fields = {
        "archive",
        "symbol",
        "day",
        "archive_sha256",
        "expected_sha256",
        "member",
        "archive_bytes",
        "checksum_name",
        "checksum_bytes",
        "checksum_sha256",
        "accepted_trade_count",
        "rejected_trade_count",
        "duplicate_trade_count",
        "out_of_order_trade_count",
        "first_event_at",
        "last_event_at",
        "normalized_file",
        "normalized_sha256",
        "first_trade_id",
        "last_trade_id",
        "missing_trade_id_count",
        "missing_trade_id_ranges",
    }
    previous_day: date | None = None
    previous_last_trade_id: int | None = None
    accepted_total = 0
    for index, archive in enumerate(archives):
        if not isinstance(archive, dict) or set(archive) != archive_fields:
            raise ValueError(f"Dataset archive {index} has an unexpected schema")
        day_text = archive["day"]
        if not isinstance(day_text, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day_text):
            raise ValueError(f"Dataset archive {index} has an invalid day")
        archive_day = date.fromisoformat(day_text)
        if archive_day.isoformat() != day_text or (
            previous_day is not None and archive_day != previous_day + timedelta(days=1)
        ):
            raise ValueError("Dataset archive dates must be canonical, ordered, and contiguous")
        previous_day = archive_day
        archive_name = f"{SUPPORTED_SYMBOL}-trades-{day_text}.zip"
        checksum_name = f"{archive_name}.CHECKSUM"
        member_name = f"{SUPPORTED_SYMBOL}-trades-{day_text}.csv"
        if (
            archive["archive"] != archive_name
            or archive["checksum_name"] not in {"", checksum_name}
            or archive["member"] != member_name
            or archive["symbol"] != SUPPORTED_SYMBOL
        ):
            raise ValueError(f"Dataset archive {index} identity is invalid")
        for count_name in (
            "archive_bytes",
            "checksum_bytes",
            "accepted_trade_count",
            "rejected_trade_count",
            "duplicate_trade_count",
            "out_of_order_trade_count",
            "missing_trade_id_count",
        ):
            if not is_nonnegative_int(archive[count_name]):
                raise ValueError(f"Dataset archive {index} has invalid {count_name}")
        if (
            int(archive["accepted_trade_count"]) < 1
            or int(archive["rejected_trade_count"]) != 0
            or int(archive["duplicate_trade_count"]) != 0
            or int(archive["out_of_order_trade_count"]) != 0
            or int(archive["missing_trade_id_count"]) != 0
            or archive["missing_trade_id_ranges"] != []
        ):
            raise ValueError(f"Dataset archive {index} contains quarantined source anomalies")
        if not is_sha256_hex(archive["archive_sha256"]) or not is_sha256_hex(
            archive["expected_sha256"]
        ) or archive["archive_sha256"] != archive["expected_sha256"]:
            raise ValueError(f"Dataset archive {index} checksum binding is invalid")
        if lineage_kind != "SYNTHETIC_LOCAL" and (
            archive["archive_sha256"] == "0" * 64
            or not is_positive_int(archive["archive_bytes"])
            or archive["checksum_name"] != checksum_name
            or not is_positive_int(archive["checksum_bytes"])
            or int(archive["checksum_bytes"]) > MAX_CHECKSUM_BYTES
            or not is_sha256_hex(archive["checksum_sha256"])
        ):
            raise ValueError(f"Dataset archive {index} lacks materialized checksum evidence")
        first_event = validate_canonical_timestamp(
            archive["first_event_at"], f"archives[{index}].first_event_at"
        )
        last_event = validate_canonical_timestamp(
            archive["last_event_at"], f"archives[{index}].last_event_at"
        )
        day_start = datetime(archive_day.year, archive_day.month, archive_day.day, tzinfo=UTC)
        if not day_start <= first_event <= last_event < day_start + timedelta(days=1):
            raise ValueError(f"Dataset archive {index} events fall outside the named UTC day")
        first_trade_id = parse_positive_trade_id(
            archive["first_trade_id"], f"archives[{index}].first_trade_id"
        )
        last_trade_id = parse_positive_trade_id(
            archive["last_trade_id"], f"archives[{index}].last_trade_id"
        )
        if (
            last_trade_id - first_trade_id + 1 != int(archive["accepted_trade_count"])
            or (previous_last_trade_id is not None and first_trade_id != previous_last_trade_id + 1)
        ):
            raise ValueError("Dataset archive trade IDs are not complete and contiguous")
        previous_last_trade_id = last_trade_id
        normalized_file = archive["normalized_file"]
        normalized_sha = archive["normalized_sha256"]
        if not isinstance(normalized_file, str) or not isinstance(normalized_sha, str):
            raise ValueError(f"Dataset archive {index} normalized-file evidence is invalid")
        if bool(normalized_file) != bool(normalized_sha) or (
            normalized_sha and not is_sha256_hex(normalized_sha)
        ):
            raise ValueError(f"Dataset archive {index} normalized-file binding is incomplete")
        if lineage_kind == "PUBLIC_BINANCE_ARCHIVE" and (
            normalized_file or normalized_sha
        ):
            raise ValueError("Streamed archive preparation cannot claim normalized-file lineage")
        accepted_total += int(archive["accepted_trade_count"])
    if archives:
        expected_start_date = str(archives[0]["day"])
        expected_end_date = (date.fromisoformat(str(archives[-1]["day"])) + timedelta(days=1)).isoformat()
        if (
            source["startDateInclusive"] != expected_start_date
            or source["endDateExclusive"] != expected_end_date
            or int(value["acceptedTradeCount"]) != accepted_total
        ):
            raise ValueError("Dataset source range or accepted-trade aggregate is invalid")
        source_start = datetime.combine(
            date.fromisoformat(expected_start_date), datetime.min.time(), tzinfo=UTC
        )
        source_end = datetime.combine(
            date.fromisoformat(expected_end_date), datetime.min.time(), tzinfo=UTC
        )
        schedule = target["candidateSchedule"]
        duration_seconds = int(target["durationSeconds"])
        validated_gaps = validate_aligned_gap_window_starts(
            gap_starts,
            "Dataset manifest gapWindowStarts",
            duration_seconds=duration_seconds,
            range_start=source_start,
            range_end=source_end,
            require_complete_daily_edges=True,
        )
        total_window_count = int(
            (source_end - source_start).total_seconds() // duration_seconds
        )
        poisoned_window_indices: set[int] = set()
        for gap in validated_gaps:
            gap_index = int((gap - source_start).total_seconds()) // duration_seconds
            first_poisoned = max(13, gap_index)
            last_poisoned = min(total_window_count - 1, gap_index + 13)
            poisoned_window_indices.update(
                range(first_poisoned, last_poisoned + 1)
            )
        expected_window_count = total_window_count - 13 - len(
            poisoned_window_indices
        )
        if expected_window_count < 1:
            raise ValueError("Dataset gaps leave no eligible prepared windows")
        first_eligible_window = next(
            index
            for index in range(13, total_window_count)
            if index not in poisoned_window_indices
        )
        last_eligible_window = next(
            index
            for index in range(total_window_count - 1, 12, -1)
            if index not in poisoned_window_indices
        )
        expected_start_at = source_start + timedelta(
            seconds=(
                first_eligible_window * duration_seconds
                + int(schedule["firstDecisionOffsetSeconds"])
            )
        )
        expected_end_at = source_start + timedelta(
            seconds=(last_eligible_window + 1) * duration_seconds
        )
        rows_per_window = (
            (
                int(schedule["lastDecisionOffsetSeconds"])
                - int(schedule["firstDecisionOffsetSeconds"])
            )
            // int(schedule["cadenceSeconds"])
            + 1
        )
        if (
            start_at != expected_start_at
            or end_at != expected_end_at
            or window_count != expected_window_count
            or int(value["preparedDecisionRowCount"]) != expected_window_count * rows_per_window
        ):
            raise ValueError(
                "Prepared coverage does not match the gap-abstaining source schedule"
            )
    elif canonical_gaps:
        raise ValueError("Archive-free dataset manifest cannot contain gap lineage")
    if lineage_kind == "PUBLIC_BINANCE_ARCHIVE":
        validate_embedded_acquisition_evidence(
            source["acquisitionEvidence"], archives, source["startDateInclusive"], source["endDateExclusive"]
        )
    elif source["acquisitionEvidence"] is not None:
        raise ValueError("Non-public lineage cannot carry official acquisition evidence")
    return value


def validate_canonical_timestamp(value: object, label: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a canonical UTC timestamp")
    try:
        parsed = parse_timestamp(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} must be a valid UTC timestamp") from error
    if format_timestamp(parsed) != value:
        raise ValueError(f"{label} must use canonical millisecond UTC text")
    return parsed


def parse_positive_trade_id(value: object, label: str) -> int:
    if not isinstance(value, str) or not re.fullmatch(r"[1-9]\d*", value):
        raise ValueError(f"{label} must be a canonical positive decimal trade ID")
    return int(value)


def validate_embedded_acquisition_evidence(
    value: object,
    archives: Sequence[dict[str, object]],
    source_start_date: object,
    source_end_date: object,
) -> None:
    required = {
        "schemaVersion",
        "acquisitionManifestSha256",
        "acquisitionArchiveIndexSha256",
        "completedAt",
        "freshOfficialTransportEvidence",
        "archives",
    }
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError("Public lineage acquisition binding has an unexpected schema")
    if (
        value["schemaVersion"] != "flippars.public-binance-acquisition-binding/1"
        or value["freshOfficialTransportEvidence"] is not True
        or not is_sha256_hex(value["acquisitionManifestSha256"])
        or not is_sha256_hex(value["acquisitionArchiveIndexSha256"])
    ):
        raise ValueError("Public lineage acquisition binding is invalid")
    validate_utc_roundtrip_timestamp(value["completedAt"], "acquisitionEvidence.completedAt")
    records = value["archives"]
    if not isinstance(records, list) or len(records) != len(archives) or not records:
        raise ValueError("Public lineage acquisition binding does not cover every archive")
    fields = (
        "day",
        "archiveName",
        "archiveBytes",
        "archiveSha256",
        "checksumName",
        "checksumBytes",
        "checksumSha256",
        "expectedArchiveSha256",
        "archiveSourceUri",
        "requestedChecksumUri",
        "finalChecksumUri",
        "checksumRetrievedAt",
    )
    canonical_records: list[dict[str, object]] = []
    for index, (record, archive) in enumerate(zip(records, archives)):
        if not isinstance(record, dict) or set(record) != set(fields):
            raise ValueError(f"Embedded acquisition archive {index} has an unexpected schema")
        day_text = str(archive["day"])
        archive_name = f"{SUPPORTED_SYMBOL}-trades-{day_text}.zip"
        checksum_name = f"{archive_name}.CHECKSUM"
        archive_uri = (
            "https://data.binance.vision/data/spot/daily/trades/"
            f"{SUPPORTED_SYMBOL}/{archive_name}"
        )
        checksum_uri = f"{archive_uri}.CHECKSUM"
        if (
            record["day"] != day_text
            or record["archiveName"] != archive_name
            or record["archiveBytes"] != archive["archive_bytes"]
            or record["archiveSha256"] != archive["archive_sha256"]
            or record["checksumName"] != checksum_name
            or record["checksumBytes"] != archive["checksum_bytes"]
            or record["checksumSha256"] != archive["checksum_sha256"]
            or record["expectedArchiveSha256"] != archive["expected_sha256"]
            or record["archiveSourceUri"] != archive_uri
            or record["requestedChecksumUri"] != checksum_uri
            or record["finalChecksumUri"] != checksum_uri
        ):
            raise ValueError(f"Embedded acquisition archive {index} is not bound to its report")
        validate_utc_roundtrip_timestamp(
            record["checksumRetrievedAt"],
            f"acquisitionEvidence.archives[{index}].checksumRetrievedAt",
        )
        canonical_records.append({name: record[name] for name in fields})
    expected_digest = hashlib.sha256(
        canonical_json(canonical_records).encode("utf-8")
    ).hexdigest()
    if value["acquisitionArchiveIndexSha256"] != expected_digest:
        raise ValueError("Embedded acquisition archive-index digest is invalid")
    if (
        records[0]["day"] != source_start_date
        or (date.fromisoformat(str(records[-1]["day"])) + timedelta(days=1)).isoformat()
        != source_end_date
    ):
        raise ValueError("Embedded acquisition evidence does not cover the source date range")


def validate_acquisition_evidence(
    path: Path,
    reports: Sequence[ArchiveReport],
    source_start_date: str | None,
    source_end_date: str | None,
) -> dict[str, object]:
    manifest, manifest_sha256 = read_json_object_and_sha256(path)
    required_top = {
        "schemaVersion",
        "completionState",
        "completedAt",
        "source",
        "window",
        "materialization",
        "archiveRoot",
        "archives",
        "acquisitionArchiveIndexSha256",
        "cacheInventoryBefore",
        "cacheInventoryAfter",
        "isolatedIntegrity",
        "freshOfficialTransportEvidence",
        "credentialsUsed",
        "tradingApiUsed",
    }
    if set(manifest) != required_top:
        raise ValueError("Acquisition manifest has an unexpected schema")
    if (
        manifest["schemaVersion"] != 3
        or manifest["completionState"] != "COMPLETE"
        or manifest["freshOfficialTransportEvidence"] is not True
        or manifest["credentialsUsed"] is not False
        or manifest["tradingApiUsed"] is not False
        or manifest["materialization"] not in {"ATOMIC_COPY", "HARD_LINK"}
    ):
        raise ValueError("Acquisition manifest is not complete governed public evidence")
    completed_at = validate_utc_roundtrip_timestamp(manifest["completedAt"], "completedAt")
    source = manifest["source"]
    if not isinstance(source, dict) or set(source) != {
        "provider", "marketType", "symbol", "dataKind", "timeBasis", "cache"
    }:
        raise ValueError("Acquisition source has an unexpected schema")
    if (
        source["provider"] != "Binance Data Vision"
        or source["marketType"] != "SPOT"
        or source["symbol"] != SUPPORTED_SYMBOL
        or source["dataKind"] != "DAILY_TRADES"
        or source["timeBasis"] != "EVENT_TIME"
        or not isinstance(source["cache"], str)
        or not source["cache"]
    ):
        raise ValueError("Acquisition source is not public Binance Spot BTCUSDT trades")
    window = manifest["window"]
    if not isinstance(window, dict) or set(window) != {
        "startInclusive", "endExclusive", "dayCount"
    }:
        raise ValueError("Acquisition window has an unexpected schema")
    if (
        window["startInclusive"] != source_start_date
        or window["endExclusive"] != source_end_date
        or not is_nonnegative_int(window["dayCount"])
        or int(window["dayCount"]) != len(reports)
    ):
        raise ValueError("Acquisition window does not match the prepared archive range")
    for name in ("cacheInventoryBefore", "cacheInventoryAfter", "isolatedIntegrity"):
        validate_sha256_record(manifest[name], f"acquisition {name}")
    if not isinstance(manifest["archiveRoot"], str) or not manifest["archiveRoot"]:
        raise ValueError("Acquisition archive root is invalid")
    raw_archives = manifest["archives"]
    if not isinstance(raw_archives, list) or len(raw_archives) != len(reports):
        raise ValueError("Acquisition archive evidence does not cover every prepared archive")
    fields = (
        "day",
        "archiveName",
        "archiveBytes",
        "archiveSha256",
        "checksumName",
        "checksumBytes",
        "checksumSha256",
        "expectedArchiveSha256",
        "archiveSourceUri",
        "requestedChecksumUri",
        "finalChecksumUri",
        "checksumRetrievedAt",
    )
    projected: list[dict[str, object]] = []
    previous_day: date | None = None
    for index, (raw, report) in enumerate(zip(raw_archives, reports)):
        if not isinstance(raw, dict) or tuple(raw) != fields:
            raise ValueError(f"Acquisition archive {index} has an unexpected schema or key order")
        day_text = raw["day"]
        if not isinstance(day_text, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day_text):
            raise ValueError(f"Acquisition archive {index} has an invalid day")
        archive_day = date.fromisoformat(day_text)
        if archive_day.isoformat() != day_text or (
            previous_day is not None and archive_day != previous_day + timedelta(days=1)
        ):
            raise ValueError("Acquisition archive days are not canonical and contiguous")
        previous_day = archive_day
        archive_name = f"{SUPPORTED_SYMBOL}-trades-{day_text}.zip"
        checksum_name = f"{archive_name}.CHECKSUM"
        archive_uri = (
            "https://data.binance.vision/data/spot/daily/trades/"
            f"{SUPPORTED_SYMBOL}/{archive_name}"
        )
        checksum_uri = f"{archive_uri}.CHECKSUM"
        for count_name in ("archiveBytes", "checksumBytes"):
            if not is_positive_int(raw[count_name]):
                raise ValueError(f"Acquisition archive {index} has invalid {count_name}")
        if int(raw["checksumBytes"]) > MAX_CHECKSUM_BYTES:
            raise ValueError(f"Acquisition archive {index} checksum is too large")
        for digest_name in (
            "archiveSha256", "checksumSha256", "expectedArchiveSha256"
        ):
            if not is_sha256_hex(raw[digest_name]) or str(raw[digest_name]) == "0" * 64:
                raise ValueError(f"Acquisition archive {index} has invalid {digest_name}")
        if (
            raw["archiveName"] != archive_name
            or raw["checksumName"] != checksum_name
            or raw["archiveSha256"] != raw["expectedArchiveSha256"]
            or raw["archiveSourceUri"] != archive_uri
            or raw["requestedChecksumUri"] != checksum_uri
            or raw["finalChecksumUri"] != checksum_uri
        ):
            raise ValueError(f"Acquisition archive {index} identity or pinned URI is invalid")
        retrieved_at = validate_utc_roundtrip_timestamp(
            raw["checksumRetrievedAt"], f"archives[{index}].checksumRetrievedAt"
        )
        if retrieved_at > completed_at:
            raise ValueError("Checksum retrieval cannot be later than acquisition completion")
        if (
            report.day != day_text
            or report.archive != archive_name
            or report.archive_bytes != raw["archiveBytes"]
            or report.archive_sha256 != raw["archiveSha256"]
            or report.expected_sha256 != raw["expectedArchiveSha256"]
            or report.checksum_name != checksum_name
            or report.checksum_bytes != raw["checksumBytes"]
            or report.checksum_sha256 != raw["checksumSha256"]
        ):
            raise ValueError(f"Prepared archive {index} disagrees with acquisition evidence")
        projected.append({name: raw[name] for name in fields})
    expected_index_digest = hashlib.sha256(
        canonical_json(projected).encode("utf-8")
    ).hexdigest()
    if manifest["acquisitionArchiveIndexSha256"] != expected_index_digest:
        raise ValueError("Acquisition archive-index digest does not match its canonical records")
    return {
        "schemaVersion": "flippars.public-binance-acquisition-binding/1",
        "acquisitionManifestSha256": manifest_sha256,
        "acquisitionArchiveIndexSha256": expected_index_digest,
        "completedAt": manifest["completedAt"],
        "freshOfficialTransportEvidence": True,
        "archives": projected,
    }


def validate_sha256_record(value: object, label: str) -> None:
    if not isinstance(value, dict) or set(value) != {
        "Path", "Bytes", "LastWriteTimeUtc", "Sha256"
    }:
        raise ValueError(f"{label} has an unexpected SHA-256 record schema")
    if (
        not isinstance(value["Path"], str)
        or not value["Path"]
        or not is_positive_int(value["Bytes"])
        or not is_sha256_hex(value["Sha256"])
    ):
        raise ValueError(f"{label} has an invalid SHA-256 record")
    validate_utc_roundtrip_timestamp(value["LastWriteTimeUtc"], f"{label}.LastWriteTimeUtc")


def validate_utc_roundtrip_timestamp(value: object, label: str) -> datetime:
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z", value
    ):
        raise ValueError(f"{label} must be a UTC round-trip timestamp")
    try:
        return parse_timestamp(value)
    except ValueError as error:
        raise ValueError(f"{label} must be a valid UTC timestamp") from error


def is_nonnegative_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def is_positive_int(value: object) -> bool:
    return is_nonnegative_int(value) and int(value) > 0


def is_sha256_hex(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def validate_symbol(symbol: str) -> str:
    normalized = symbol.upper()
    if normalized != SUPPORTED_SYMBOL:
        raise ValueError(f"Only public Binance Spot {SUPPORTED_SYMBOL} is supported")
    return normalized


def validate_dataset_options(options: DatasetOptions) -> None:
    if options.signal_type not in SIGNAL_DURATION_SECONDS:
        raise ValueError(f"Unsupported signal type: {options.signal_type}")
    expected = SIGNAL_DURATION_SECONDS[options.signal_type] // 60
    if options.timeframe_minutes != expected:
        raise ValueError(f"{options.signal_type} requires timeframe-minutes={expected}")
    if not math.isfinite(options.deadband_bps) or options.deadband_bps != DEFAULT_DEADBAND_BPS:
        raise ValueError(f"v3 label policy requires deadband-bps={DEFAULT_DEADBAND_BPS:g}")
    duration = options.timeframe_minutes * 60
    if options.decision_cadence_seconds != DEFAULT_DECISION_CADENCE_SECONDS:
        raise ValueError("v3 decision-cadence-seconds must be 15")
    if not 1 <= options.minimum_lead_time_seconds < duration:
        raise ValueError("minimum-lead-time-seconds must be inside the candle duration")
    required_lead = SIGNAL_MINIMUM_LEAD_TIME_SECONDS[options.signal_type]
    if options.minimum_lead_time_seconds != required_lead:
        raise ValueError(
            f"{options.signal_type} requires minimum-lead-time-seconds={required_lead}"
        )


def validate_train_options(
    signal_type: str,
    version: str,
    deadband_bps: float,
    confidence_threshold: float,
    validity_days: int,
) -> None:
    if signal_type not in SIGNAL_DURATION_SECONDS:
        raise ValueError(f"Unsupported signal type: {signal_type}")
    if not VERSION_PATTERN.fullmatch(version):
        raise ValueError("version must satisfy the governed artifact VersionSchema")
    if deadband_bps != DEFAULT_DEADBAND_BPS:
        raise ValueError(f"v3 label policy requires deadband-bps={DEFAULT_DEADBAND_BPS:g}")
    if not math.isfinite(confidence_threshold) or not 0.5 <= confidence_threshold <= 1:
        raise ValueError("confidence-threshold must be between 0.5 and 1")
    if validity_days < 90 or validity_days > 365:
        raise ValueError("validity-days must be between 90 and 365 for the governed shadow protocol")


def trade_sort_key(trade: Trade) -> tuple[datetime, int | str]:
    try:
        trade_id: int | str = int(trade.trade_id)
    except ValueError:
        trade_id = trade.trade_id
    return trade.event_time, trade_id


def trade_payload(trade: Trade) -> tuple[object, ...]:
    return (
        trade.event_time, trade.price, trade.quantity, trade.quote_quantity,
        trade.is_buyer_maker, trade.source_file,
    )


def return_bps(close: float | Decimal, open_price: float | Decimal) -> float:
    close_decimal = close if isinstance(close, Decimal) else Decimal(str(close))
    open_decimal = (
        open_price if isinstance(open_price, Decimal) else Decimal(str(open_price))
    )
    return float((close_decimal / open_decimal - Decimal(1)) * Decimal(10_000))


def range_bps(high: float, low: float, open_price: float) -> float:
    return (high - low) / open_price * 10_000


def close_location(close: float, high: float, low: float) -> float:
    return 0.5 if high == low else (close - low) / (high - low)


def parse_bool(value: str) -> bool:
    if value == "true":
        return True
    if value == "false":
        return False
    raise ValueError("Expected true or false")


def parse_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("Timestamp must include a UTC offset")
    normalized = parsed.astimezone(UTC)
    if value.endswith("Z") is False and parsed.utcoffset() != timedelta(0):
        raise ValueError("Timestamp must be UTC")
    return normalized


def format_timestamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def format_trade_timestamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def finite_float(value: object, label: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{label} must be numeric")
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} must be numeric") from error
    if not math.isfinite(result):
        raise ValueError(f"{label} must be finite")
    return result


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=False)


def read_json_object(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected JSON object: {path}")
    return value


def read_json_object_and_sha256(path: Path) -> tuple[dict[str, object], str]:
    payload = path.read_bytes()
    digest = hashlib.sha256(payload).hexdigest()
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError(f"Expected strict UTF-8 JSON object: {path}") from error

    def reject_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"Duplicate JSON key {key!r}: {path}")
            result[key] = value
        return result

    def reject_constant(value: str) -> object:
        raise ValueError(f"Non-finite JSON constant {value}: {path}")

    try:
        value = json.loads(
            text,
            object_pairs_hook=reject_duplicates,
            parse_constant=reject_constant,
        )
    except (json.JSONDecodeError, ValueError) as error:
        raise ValueError(f"Expected strict JSON object: {path}") from error
    if not isinstance(value, dict):
        raise ValueError(f"Expected JSON object: {path}")
    return value, digest


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1_048_576), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_new_json(path: Path, value: object) -> None:
    if path.exists():
        raise FileExistsError(f"Refusing to overwrite existing file: {path}")
    write_json_atomic(path, value, overwrite=False)


def write_json_atomic(path: Path, value: object, *, overwrite: bool) -> None:
    if path.exists() and not overwrite:
        raise FileExistsError(f"Refusing to overwrite existing file: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            newline="\n",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".part",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            json.dump(value, handle, ensure_ascii=False, allow_nan=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        if path.exists() and not overwrite:
            raise FileExistsError(f"Refusing to overwrite existing file: {path}")
        if overwrite:
            temporary.replace(path)
        else:
            temporary.rename(path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def join_url(base_url: str, key: str) -> str:
    return f"{base_url.rstrip('/')}/{urllib.parse.quote(key, safe='/')}"


def runtime_metadata() -> dict[str, object]:
    return {
        "pythonVersion": platform.python_version(),
        "implementation": platform.python_implementation(),
        "platform": platform.platform(),
        "packageVersion": "0.3.0",
    }


def run_smoke(work_root: Path) -> dict[str, object]:
    work_root.mkdir(parents=True, exist_ok=False)
    normalized = work_root / "normalized"
    normalized.mkdir()
    start = datetime(2026, 1, 1, tzinfo=UTC)
    synthetic_digest = "0" * 64
    next_trade_id = 1
    candles_per_day = 288
    trades_per_candle = 60
    for day_index in range(2):
        day_start = start + timedelta(days=day_index)
        day_text = day_start.date().isoformat()
        normalized_path = normalized / f"BTCUSDT-trades-{day_text}.csv"
        daily_trades: list[Trade] = []
        for day_trade_index in range(candles_per_day * trades_per_candle):
            event_time = day_start + timedelta(seconds=day_trade_index * 5)
            candle_index = day_index * candles_per_day + day_trade_index // trades_per_candle
            within_candle = day_trade_index % trades_per_candle
            direction = (-1, 0, 1)[candle_index % 3]
            price = (
                50_000
                + candle_index * 3
                + direction * 70 * within_candle / 59
                + math.sin(within_candle / 5) * 0.5
            )
            quantity = 0.01 + (day_trade_index % 5) * 0.001
            daily_trades.append(
                Trade(
                    event_time,
                    str(next_trade_id),
                    price,
                    quantity,
                    price * quantity,
                    next_trade_id % 2 == 0,
                    normalized_path.name,
                )
            )
            next_trade_id += 1
        with normalized_path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle, lineterminator="\n")
            writer.writerow(NORMALIZED_HEADER)
            for trade in daily_trades:
                writer.writerow(
                    (
                        format_timestamp(trade.event_time),
                        trade.trade_id,
                        trade.price,
                        trade.quantity,
                        trade.quote_quantity,
                        str(trade.is_buyer_maker).lower(),
                        trade.source_file,
                    )
                )
        report = ArchiveReport(
            archive=f"BTCUSDT-trades-{day_text}.zip",
            symbol=SUPPORTED_SYMBOL,
            day=day_text,
            archive_sha256=synthetic_digest,
            expected_sha256=synthetic_digest,
            member=f"BTCUSDT-trades-{day_text}.csv",
            accepted_trade_count=len(daily_trades),
            first_event_at=format_timestamp(daily_trades[0].event_time),
            last_event_at=format_timestamp(daily_trades[-1].event_time),
            normalized_file=normalized_path.name,
            normalized_sha256=sha256_file(normalized_path),
            first_trade_id=daily_trades[0].trade_id,
            last_trade_id=daily_trades[-1].trade_id,
        )
        write_new_json(
            normalized / f"BTCUSDT-trades-{day_text}.report.json", asdict(report)
        )
    prepared = work_root / "prepared.jsonl"
    manifest = work_root / "manifest.json"
    artifact = work_root / "artifact.json"
    evaluation = work_root / "evaluation.json"
    prepare_dataset(
        normalized_root=normalized,
        output=prepared,
        manifest_output=manifest,
        signal_type="FIVE_MINUTE_EARLY_DIRECTION",
        deadband_bps=DEFAULT_DEADBAND_BPS,
        timeframe_minutes=5,
        decision_cadence_seconds=15,
        minimum_lead_time_seconds=15,
        lineage_kind="SYNTHETIC_LOCAL",
    )
    result = train_draft(
        input_path=prepared,
        manifest_path=manifest,
        output_path=artifact,
        evaluation_path=evaluation,
        signal_type="FIVE_MINUTE_EARLY_DIRECTION",
        version="smoke-1",
        deadband_bps=DEFAULT_DEADBAND_BPS,
        confidence_threshold=0.75,
        validity_days=DEFAULT_VALIDITY_DAYS,
    )
    return {"ok": True, **result}


if __name__ == "__main__":
    main()

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import tempfile
import unittest
import zipfile
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from unittest import mock

import numpy as np
import flippars_model_training.pipeline as pipeline_module

from flippars_model_training.pipeline import (
    CLASS_ORDER,
    DEFAULT_DEADBAND_BPS,
    FEATURE_NAMES,
    PRE_EVALUATION_POLICY_CANONICALIZATION,
    PRE_EVALUATION_POLICY_SCHEMA_VERSION,
    ArchiveReport,
    DatasetOptions,
    Trade,
    block_bootstrap_policy,
    build_pre_evaluation_policy,
    canonical_decimal_string,
    canonical_json,
    canonical_policy_json,
    chronological_split,
    close_relation,
    decision_offsets,
    dataset_manifest_summary,
    download_atomic,
    examples_from_trades,
    fit_multinomial,
    format_timestamp,
    iter_archive_rows,
    iter_training_window_groups,
    multinomial_objective,
    multinomial_objective_and_gradient,
    normalize_archive,
    outcome_support_report,
    parse_checksum_file,
    parse_canonical_preimage_object,
    parse_timestamp,
    parse_trade_row,
    policy_digest,
    prepare_archives,
    pre_evaluation_sampling_contract,
    replay_policy,
    select_offline_archives,
    softmax,
    stream_archive_candles,
    time_block_metric_intervals,
    validate_archive_identity,
    validate_acquisition_evidence,
    validate_dataset_options,
    validate_dataset_manifest,
    validate_training_row,
    validate_train_options,
    walk_forward_evaluation,
    window_balanced_weights,
    write_prepared_dataset,
)


def options(signal_type: str) -> DatasetOptions:
    return DatasetOptions(
        signal_type=signal_type,
        deadband_bps=DEFAULT_DEADBAND_BPS,
        timeframe_minutes=15 if signal_type == "FIFTEEN_MINUTE_REVERSAL" else 5,
        decision_cadence_seconds=15,
        minimum_lead_time_seconds=30 if signal_type == "FIFTEEN_MINUTE_REVERSAL" else 15,
    )


def sampling_metadata_fixture() -> dict[str, object]:
    return {
        "method": "DETERMINISTIC_COMPLETE_WINDOW_HASH_RESERVOIR",
        "seed": 20260814,
        "corpusRowCount": 1_000,
        "corpusWindowCount": 300,
        "corpusPartitionWindowCounts": {
            "modelFit": 180,
            "calibration": 60,
            "evaluation": 60,
        },
        "corpusPartitionRowCounts": {
            "train": 600,
            "calibration": 200,
            "holdout": 200,
        },
        "sampledWindowLimits": {"train": 100, "calibration": 50, "holdout": 50},
        "sampledWindowCounts": {"train": 100, "calibration": 50, "holdout": 50},
        "sampledRowCounts": {"train": 300, "calibration": 150, "holdout": 150},
        "sampledWindowSelectionSha256": "a" * 64,
        "partitionStarts": {
            "train": "2025-01-01T00:00:00.000Z",
            "calibration": "2025-02-01T00:00:00.000Z",
            "holdout": "2025-03-01T00:00:00.000Z",
        },
        "partitionEnds": {
            "train": "2025-01-31T00:00:00.000Z",
            "calibration": "2025-02-28T00:00:00.000Z",
            "holdout": "2025-03-31T00:00:00.000Z",
        },
        "oodFitScope": "SAMPLED_MODEL_FIT_WINDOWS",
        "evaluationScope": "SAMPLED_DIAGNOSTIC_ONLY",
    }


def replay_ood(lower: float = 0.0, upper: float = 1.0) -> dict[str, object]:
    return {"rawBounds": {"lower": [lower], "upper": [upper]}}


def synthetic_trades(candle_count: int = 120) -> list[Trade]:
    start = datetime(2026, 1, 1, tzinfo=UTC)
    result: list[Trade] = []
    trade_id = 1
    for candle_index in range(candle_count):
        direction = (-1, 0, 1)[candle_index % 3]
        for offset in range(0, 300, 15):
            price = 50_000 + candle_index * 2 + direction * offset * 0.08
            result.append(
                Trade(
                    start + timedelta(seconds=candle_index * 300 + offset),
                    str(trade_id),
                    price,
                    0.01,
                    price * 0.01,
                    trade_id % 2 == 0,
                    "synthetic.csv",
                )
            )
            trade_id += 1
    return result


class TradeParsingTests(unittest.TestCase):
    def test_timestamp_unit_transition_is_locked_at_2025_01_01(self) -> None:
        milliseconds = parse_trade_row(
            ["1", "50000", "0.1", "5000", "1735603200123", "true", "x"],
            "BTCUSDT-trades-2024-12-31.zip",
            expected_day=date(2024, 12, 31),
        )
        microseconds = parse_trade_row(
            ["1", "50000", "0.1", "5000", "1735689600123000", "true", "x"],
            "BTCUSDT-trades-2025-01-01.zip",
            expected_day=date(2025, 1, 1),
        )
        self.assertIsNotNone(milliseconds)
        self.assertIsNotNone(microseconds)
        self.assertEqual(
            milliseconds.event_time,
            datetime(2024, 12, 31, 0, 0, 0, 123000, tzinfo=UTC),
        )
        self.assertEqual(
            microseconds.event_time,
            datetime(2025, 1, 1, 0, 0, 0, 123000, tzinfo=UTC),
        )
        self.assertIsNone(
            parse_trade_row(
                ["1", "50000", "0.1", "5000", "1735689600123", "true", "x"],
                "BTCUSDT-trades-2025-01-01.zip",
                expected_day=date(2025, 1, 1),
            )
        )
        self.assertIsNone(
            parse_trade_row(
                ["1", "50000", "0.1", "5000", "1735603200123000", "true", "x"],
                "BTCUSDT-trades-2024-12-31.zip",
                expected_day=date(2024, 12, 31),
            )
        )

    def test_microseconds_are_not_rounded_through_float(self) -> None:
        trade = parse_trade_row(
            ["1", "50000", "0.1", "5000", "1735689600123456", "false", "x"],
            "BTCUSDT-trades-2025-01-01.zip",
            expected_day=date(2025, 1, 1),
        )
        self.assertIsNotNone(trade)
        self.assertEqual(trade.event_time, datetime(2025, 1, 1, 0, 0, 0, 123456, tzinfo=UTC))

    def test_unsupported_or_ambiguous_timestamp_units_reject(self) -> None:
        for timestamp in ("1735689600", "1735689600123456789", "1735689600123.0"):
            with self.subTest(timestamp=timestamp):
                self.assertIsNone(
                    parse_trade_row(
                        ["1", "50000", "0.1", "5000", timestamp, "true", "x"],
                        "BTCUSDT-trades-2025-01-01.zip",
                        expected_day=date(2025, 1, 1),
                    )
                )

    def test_wrong_day_and_malformed_maker_reject(self) -> None:
        self.assertIsNone(
            parse_trade_row(
                ["1", "50000", "0.1", "5000", "1735689600123", "maybe", "x"],
                "x",
                expected_day=date(2025, 1, 1),
            )
        )
        self.assertIsNone(
            parse_trade_row(
                ["1", "50000", "0.1", "5000", "1735689600123", "true", "x"],
                "x",
                expected_day=date(2025, 1, 2),
            )
        )


class ArchiveTests(unittest.TestCase):
    def build_archive(self, root: Path, *, member: str | None = None) -> Path:
        path = root / "BTCUSDT-trades-2025-01-01.zip"
        member_name = member or "BTCUSDT-trades-2025-01-01.csv"
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(
                member_name,
                "id,price,qty,quoteQty,time,isBuyerMaker,isBestMatch\n"
                "1,50000,0.1,5000,1735689600000000,true,true\n",
            )
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        path.with_suffix(".zip.CHECKSUM").write_text(f"{digest}  {path.name}\n", encoding="utf-8")
        return path

    def test_symbol_member_and_checksum_are_strict(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.build_archive(root)
            self.assertEqual(
                validate_archive_identity(path, "BTCUSDT", date(2025, 1, 1)),
                "BTCUSDT-trades-2025-01-01.csv",
            )
            self.assertEqual(parse_checksum_file(path.with_suffix(".zip.CHECKSUM"), path.name), hashlib.sha256(path.read_bytes()).hexdigest())
            with self.assertRaises(ValueError):
                validate_archive_identity(path, "ETHUSDT", date(2025, 1, 1))
            unsafe = self.build_archive(root, member="nested/BTCUSDT-trades-2025-01-01.csv")
            with self.assertRaises(ValueError):
                validate_archive_identity(unsafe, "BTCUSDT", date(2025, 1, 1))

    def test_noncontiguous_trade_ids_quarantine(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "BTCUSDT-trades-2025-01-01.zip"
            with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr(
                    "BTCUSDT-trades-2025-01-01.csv",
                    "1,50000,0.1,5000,1735689600000000,true,true\n"
                    "3,50001,0.1,5000.1,1735689615000000,false,true\n",
                )
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            path.with_suffix(".zip.CHECKSUM").write_text(f"{digest}  {path.name}\n", encoding="utf-8")
            report, _ = stream_archive_candles(path, options("FIVE_MINUTE_EARLY_DIRECTION"), previous_day_last_id=None, previous_day_last_event=None)
            self.assertEqual(report.missing_trade_id_count, 1)
            self.assertEqual(report.missing_trade_id_ranges, ["2-2"])

    def test_normalized_archive_retains_complete_source_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.build_archive(root)
            report = normalize_archive(path, root / "normalized")
            self.assertEqual(report.archive_bytes, path.stat().st_size)
            self.assertGreater(report.checksum_bytes, 0)
            self.assertRegex(report.checksum_sha256, r"^[a-f0-9]{64}$")
            self.assertEqual(report.first_trade_id, "1")
            self.assertEqual(report.last_trade_id, "1")
            self.assertEqual(report.missing_trade_id_count, 0)
            self.assertEqual(report.missing_trade_id_ranges, [])

    def test_missing_or_mutated_official_checksum_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.build_archive(root)
            checksum_path = path.with_suffix(".zip.CHECKSUM")
            checksum_path.unlink()
            with self.assertRaises(FileNotFoundError):
                stream_archive_candles(
                    path,
                    options("FIVE_MINUTE_EARLY_DIRECTION"),
                    previous_day_last_id=None,
                    previous_day_last_event=None,
                )
            checksum_path.write_text(
                f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n",
                encoding="utf-8",
            )
            with path.open("ab") as handle:
                handle.write(b"x")
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                stream_archive_candles(
                    path,
                    options("FIVE_MINUTE_EARLY_DIRECTION"),
                    previous_day_last_id=None,
                    previous_day_last_event=None,
                )

    def test_archive_path_swap_between_hash_and_stream_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.build_archive(root)
            replacement_root = root / "replacement"
            replacement_root.mkdir()
            replacement = replacement_root / path.name
            with zipfile.ZipFile(
                replacement, "w", compression=zipfile.ZIP_DEFLATED
            ) as archive:
                archive.writestr(
                    "BTCUSDT-trades-2025-01-01.csv",
                    "1,60000,0.1,6000,1735689600000000,true,true\n",
                )
            calls = 0

            def hash_then_swap(candidate: Path) -> str:
                nonlocal calls
                digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
                if candidate == path and calls == 0:
                    calls += 1
                    replacement.replace(path)
                return digest

            with mock.patch(
                "flippars_model_training.pipeline.sha256_file",
                side_effect=hash_then_swap,
            ), self.assertRaisesRegex(ValueError, "Archive changed while being read"):
                stream_archive_candles(
                    path,
                    options("FIVE_MINUTE_EARLY_DIRECTION"),
                    previous_day_last_id=None,
                    previous_day_last_event=None,
                )

    def test_is_buyer_maker_maps_to_aggressive_sell_volume(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "BTCUSDT-trades-2025-01-01.zip"
            with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr(
                    "BTCUSDT-trades-2025-01-01.csv",
                    "1,50000,0.1,5000,1735689600000000,true,true\n"
                    "2,50001,0.3,15000.3,1735689615000000,false,true\n",
                )
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            path.with_suffix(".zip.CHECKSUM").write_text(
                f"{digest}  {path.name}\n", encoding="utf-8"
            )
            _, candles = stream_archive_candles(
                path,
                options("FIVE_MINUTE_EARLY_DIRECTION"),
                previous_day_last_id=None,
                previous_day_last_event=None,
            )
            self.assertAlmostEqual(candles[0].buy_volume, 0.3)
            self.assertAlmostEqual(candles[0].sell_volume, 0.1)

    def test_cross_host_download_redirect_rejects_before_materialization(self) -> None:
        class RedirectedResponse(io.BytesIO):
            def geturl(self) -> str:
                return "https://attacker.invalid/substituted.zip"

        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "archive.zip"
            with mock.patch(
                "flippars_model_training.pipeline.urllib.request.urlopen",
                return_value=RedirectedResponse(b"payload"),
            ):
                with self.assertRaisesRegex(ValueError, "final download URL"):
                    download_atomic(
                        "https://data.binance.vision/data/spot/daily/trades/BTCUSDT/archive.zip",
                        target,
                    )
            self.assertFalse(target.exists())

    def test_checksum_sidecar_rejects_extra_payload_and_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sidecar = root / "archive.zip.CHECKSUM"
            digest = "a" * 64
            invalid_values = (
                f"{digest}  nested/archive.zip\n",
                f"{digest}  archive.zip\n{digest}  archive.zip\n",
                f"{digest}\tarchive.zip\n",
                f"{digest}  archive.zip\n\n",
            )
            for value in invalid_values:
                sidecar.write_text(value, encoding="utf-8")
                with self.assertRaises(ValueError):
                    parse_checksum_file(sidecar, "archive.zip")
            sidecar.write_bytes(b"a" * 1_025)
            with self.assertRaises(ValueError):
                parse_checksum_file(sidecar, "archive.zip")

    def test_offline_selector_requires_the_exact_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for day in ("2025-01-01", "2025-01-02"):
                archive = root / f"BTCUSDT-trades-{day}.zip"
                archive.write_bytes(b"zip")
                archive.with_suffix(".zip.CHECKSUM").write_text("checksum", encoding="utf-8")
            selected = select_offline_archives(
                root, date(2025, 1, 1), date(2025, 1, 3)
            )
            self.assertEqual(len(selected), 2)
            (root / "unexpected.txt").write_text("x", encoding="utf-8")
            with self.assertRaises(ValueError):
                select_offline_archives(root, date(2025, 1, 1), date(2025, 1, 3))


class ResumableArchivePreparationTests(unittest.TestCase):
    def build_daily_archives(self, root: Path, day_count: int = 3) -> list[Path]:
        root.mkdir(parents=True, exist_ok=True)
        start = datetime(2025, 1, 1, tzinfo=UTC)
        trade_id = 1
        paths: list[Path] = []
        for day_index in range(day_count):
            day_start = start + timedelta(days=day_index)
            day_text = day_start.date().isoformat()
            archive_path = root / f"BTCUSDT-trades-{day_text}.zip"
            member_name = f"BTCUSDT-trades-{day_text}.csv"
            lines = ["id,price,qty,quoteQty,time,isBuyerMaker,isBestMatch\n"]
            for candle_index in range(288):
                event_time = day_start + timedelta(minutes=5 * candle_index)
                price = 50_000 + day_index * 100 + (candle_index % 17) - 8
                quantity = 0.1 + (candle_index % 3) * 0.01
                quote_quantity = price * quantity
                timestamp = int(event_time.timestamp() * 1_000_000)
                maker = "true" if trade_id % 2 == 0 else "false"
                lines.append(
                    f"{trade_id},{price},{quantity},{quote_quantity},"
                    f"{timestamp},{maker},true\n"
                )
                trade_id += 1
            with zipfile.ZipFile(
                archive_path, "w", compression=zipfile.ZIP_DEFLATED
            ) as archive:
                archive.writestr(member_name, "".join(lines))
            digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
            archive_path.with_suffix(".zip.CHECKSUM").write_text(
                f"{digest}  {archive_path.name}\n", encoding="utf-8"
            )
            paths.append(archive_path)
        return paths

    def prepare_arguments(
        self,
        archives: list[Path],
        output: Path,
        manifest: Path,
        acquisition_manifest: Path | None = None,
        signal_type: str = "FIVE_MINUTE_EARLY_DIRECTION",
    ) -> dict[str, object]:
        signal_options = options(signal_type)
        return {
            "archives": archives,
            "output": output,
            "manifest_output": manifest,
            "signal_type": signal_type,
            "deadband_bps": DEFAULT_DEADBAND_BPS,
            "timeframe_minutes": signal_options.timeframe_minutes,
            "decision_cadence_seconds": signal_options.decision_cadence_seconds,
            "minimum_lead_time_seconds": signal_options.minimum_lead_time_seconds,
            "acquisition_manifest_path": acquisition_manifest,
        }

    def write_reference(
        self,
        archives: list[Path],
        output: Path,
        manifest: Path,
        signal_type: str = "FIVE_MINUTE_EARLY_DIRECTION",
    ) -> dict[str, object]:
        reports: list[ArchiveReport] = []
        gaps: list[datetime] = []
        signal_options = options(signal_type)
        return write_prepared_dataset(
            rows=iter_archive_rows(
                archives,
                signal_options,
                reports,
                gaps,
            ),
            trades_accepted=None,
            cross_file_duplicates=0,
            reports=reports,
            gap_starts=gaps,
            output=output,
            manifest_output=manifest,
            options=signal_options,
            lineage_kind="LOCAL_ARCHIVE_REPLAY",
        )

    def interrupt_after_checkpoint(self, archive_index: int):
        original = pipeline_module.write_archive_checkpoint

        def wrapped(**kwargs):
            record = original(**kwargs)
            if kwargs["archive_index"] == archive_index:
                raise RuntimeError(f"interrupted after archive {archive_index}")
            return record

        return mock.patch(
            "flippars_model_training.pipeline.write_archive_checkpoint",
            side_effect=wrapped,
        )

    def test_multiple_resumes_are_byte_identical_to_uninterrupted_reference(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archives = self.build_daily_archives(root / "archives")
            reference_output = root / "reference" / "prepared.jsonl"
            reference_manifest = root / "reference" / "manifest.json"
            reference = self.write_reference(
                archives, reference_output, reference_manifest
            )

            resumed_output = root / "resumed" / "prepared.jsonl"
            resumed_manifest = root / "resumed" / "manifest.json"
            arguments = self.prepare_arguments(
                archives, resumed_output, resumed_manifest
            )
            with self.interrupt_after_checkpoint(1), self.assertRaisesRegex(
                RuntimeError, "archive 1"
            ):
                prepare_archives(**arguments)
            checkpoint_root = pipeline_module.archive_checkpoint_root(resumed_output)
            self.assertEqual(
                sorted(path.name for path in (checkpoint_root / "archives").iterdir()),
                ["00000001"],
            )
            with self.interrupt_after_checkpoint(2), self.assertRaisesRegex(
                RuntimeError, "archive 2"
            ):
                prepare_archives(**arguments)
            self.assertEqual(
                sorted(path.name for path in (checkpoint_root / "archives").iterdir()),
                ["00000001", "00000002"],
            )

            resumed = prepare_archives(**arguments)
            self.assertEqual(resumed_output.read_bytes(), reference_output.read_bytes())
            self.assertEqual(
                resumed["datasetContentSha256"], reference["datasetContentSha256"]
            )
            reference_value = json.loads(reference_manifest.read_text(encoding="utf-8"))
            resumed_value = json.loads(resumed_manifest.read_text(encoding="utf-8"))
            reference_value.pop("createdAt")
            resumed_value.pop("createdAt")
            self.assertEqual(resumed_value, reference_value)
            self.assertTrue(checkpoint_root.is_dir())
            self.assertEqual(
                len(list((checkpoint_root / "archives").iterdir())), len(archives)
            )

    def test_corrupt_chunk_and_checkpoint_schema_fail_closed(self) -> None:
        for corruption in ("chunk", "schema"):
            with self.subTest(corruption=corruption), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archives = self.build_daily_archives(root / "archives", day_count=2)
                output = root / "run" / "prepared.jsonl"
                manifest = root / "run" / "manifest.json"
                arguments = self.prepare_arguments(archives, output, manifest)
                with self.interrupt_after_checkpoint(1), self.assertRaises(RuntimeError):
                    prepare_archives(**arguments)
                checkpoint_directory = (
                    pipeline_module.archive_checkpoint_root(output)
                    / "archives"
                    / "00000001"
                )
                if corruption == "chunk":
                    with (checkpoint_directory / "rows.jsonl").open("ab") as handle:
                        handle.write(b"{}\n")
                    expected = "hash or size mismatch"
                else:
                    checkpoint_path = checkpoint_directory / "checkpoint.json"
                    checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
                    checkpoint["unexpected"] = True
                    checkpoint_path.write_text(
                        json.dumps(checkpoint, indent=2) + "\n", encoding="utf-8"
                    )
                    expected = "must contain exactly"
                with self.assertRaisesRegex(ValueError, expected):
                    prepare_archives(**arguments)
                self.assertFalse(output.exists())
                self.assertFalse(manifest.exists())

    def test_changed_acquisition_input_invalidates_resume_plan(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archives = self.build_daily_archives(root / "archives", day_count=2)
            acquisition = root / "acquisition.json"
            acquisition.write_text("{}\n", encoding="utf-8")
            output = root / "run" / "prepared.jsonl"
            manifest = root / "run" / "manifest.json"
            arguments = self.prepare_arguments(
                archives, output, manifest, acquisition
            )
            with self.interrupt_after_checkpoint(1), self.assertRaises(RuntimeError):
                prepare_archives(**arguments)
            acquisition.write_text('{"changed":true}\n', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "plan does not match"):
                prepare_archives(**arguments)
            self.assertFalse(output.exists())
            self.assertFalse(manifest.exists())

    def test_published_output_without_manifest_is_verified_and_replayed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archives = self.build_daily_archives(root / "archives", day_count=2)
            reference_output = root / "reference" / "prepared.jsonl"
            reference_manifest = root / "reference" / "manifest.json"
            reference = self.write_reference(
                archives, reference_output, reference_manifest
            )
            output = root / "run" / "prepared.jsonl"
            manifest = root / "run" / "manifest.json"
            arguments = self.prepare_arguments(archives, output, manifest)
            original_sha256_file = pipeline_module.sha256_file

            def fail_after_output_publication(path: Path) -> str:
                if path == output and output.is_file():
                    raise RuntimeError("simulated power loss after output publication")
                return original_sha256_file(path)

            with mock.patch(
                "flippars_model_training.pipeline.sha256_file",
                side_effect=fail_after_output_publication,
            ), self.assertRaisesRegex(RuntimeError, "power loss"):
                prepare_archives(**arguments)
            self.assertTrue(output.is_file())
            self.assertFalse(manifest.exists())
            published_bytes = output.read_bytes()
            output.write_bytes(published_bytes + b"tampered")
            with self.assertRaisesRegex(ValueError, "beyond its checkpoints"):
                prepare_archives(**arguments)
            self.assertEqual(output.read_bytes(), published_bytes + b"tampered")
            output.write_bytes(published_bytes)

            resumed = prepare_archives(**arguments)
            self.assertEqual(output.read_bytes(), reference_output.read_bytes())
            self.assertEqual(
                resumed["datasetContentSha256"], reference["datasetContentSha256"]
            )
            self.assertTrue(manifest.is_file())
            self.assertTrue(
                pipeline_module.archive_checkpoint_root(output).is_dir()
            )

    def test_completed_outputs_reconcile_with_persistent_checkpoints(self) -> None:
        for tamper_manifest in (False, True):
            with self.subTest(tamper_manifest=tamper_manifest), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archives = self.build_daily_archives(root / "archives", day_count=2)
                output = root / "run" / "prepared.jsonl"
                manifest = root / "run" / "manifest.json"
                checkpoint_root = pipeline_module.archive_checkpoint_root(output)
                arguments = self.prepare_arguments(archives, output, manifest)
                completed = prepare_archives(**arguments)
                self.assertTrue(output.is_file())
                self.assertTrue(manifest.is_file())
                self.assertTrue(checkpoint_root.is_dir())
                output_bytes = output.read_bytes()
                manifest_bytes = manifest.read_bytes()

                if tamper_manifest:
                    manifest_value = json.loads(manifest_bytes.decode("utf-8"))
                    manifest_value["preparedDatasetSha256"] = "0" * 64
                    manifest.write_text(
                        json.dumps(manifest_value, indent=2, sort_keys=True) + "\n",
                        encoding="utf-8",
                    )
                    tampered_bytes = manifest.read_bytes()
                    with self.assertRaisesRegex(ValueError, "output binding mismatch"):
                        prepare_archives(**arguments)
                    self.assertEqual(output.read_bytes(), output_bytes)
                    self.assertEqual(manifest.read_bytes(), tampered_bytes)
                    self.assertTrue(checkpoint_root.is_dir())
                else:
                    reconciled = prepare_archives(**arguments)
                    self.assertEqual(reconciled, completed)
                    self.assertEqual(output.read_bytes(), output_bytes)
                    self.assertEqual(manifest.read_bytes(), manifest_bytes)
                    self.assertTrue(checkpoint_root.is_dir())

    def test_valid_schema_summary_and_report_tampering_fail_closed(self) -> None:
        for corruption in ("summary", "report"):
            with self.subTest(corruption=corruption), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archives = self.build_daily_archives(root / "archives", day_count=2)
                output = root / "run" / "prepared.jsonl"
                manifest = root / "run" / "manifest.json"
                arguments = self.prepare_arguments(archives, output, manifest)
                with self.interrupt_after_checkpoint(1), self.assertRaises(RuntimeError):
                    prepare_archives(**arguments)
                checkpoint_path = (
                    pipeline_module.archive_checkpoint_root(output)
                    / "archives"
                    / "00000001"
                    / "checkpoint.json"
                )
                checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
                if corruption == "summary":
                    checkpoint["rows"]["windowCount"] += 1
                    expected = "row summary does not match"
                else:
                    checkpoint["report"]["accepted_trade_count"] += 1
                    expected = "trade-ID range is invalid"
                identity = dict(checkpoint)
                identity.pop("checkpointSha256")
                checkpoint["checkpointSha256"] = (
                    pipeline_module.checkpoint_identity_sha256(identity)
                )
                checkpoint_path.write_text(
                    json.dumps(checkpoint, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(ValueError, expected):
                    prepare_archives(**arguments)
                self.assertFalse(output.exists())
                self.assertFalse(manifest.exists())

    def test_initial_checkpoint_store_recovers_only_when_provably_empty(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archives = self.build_daily_archives(root / "archives", day_count=2)
            output = root / "recoverable" / "prepared.jsonl"
            manifest = root / "recoverable" / "manifest.json"
            checkpoint_root = pipeline_module.archive_checkpoint_root(output)
            checkpoint_root.mkdir(parents=True)
            (checkpoint_root / "archives").mkdir()
            plan_temporary = checkpoint_root / ".plan.json.abcdefgh.part"
            plan_temporary.write_text("incomplete", encoding="utf-8")
            prepare_archives(**self.prepare_arguments(archives, output, manifest))
            self.assertTrue(output.is_file())
            self.assertTrue(manifest.is_file())
            self.assertTrue(checkpoint_root.is_dir())

            ambiguous_output = root / "ambiguous" / "prepared.jsonl"
            ambiguous_manifest = root / "ambiguous" / "manifest.json"
            ambiguous_root = pipeline_module.archive_checkpoint_root(ambiguous_output)
            ambiguous_root.mkdir(parents=True)
            marker = ambiguous_root / "unowned.txt"
            marker.write_text("preserve", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "unexpected entries"):
                prepare_archives(
                    **self.prepare_arguments(
                        archives, ambiguous_output, ambiguous_manifest
                    )
                )
            self.assertEqual(marker.read_text(encoding="utf-8"), "preserve")
            self.assertFalse(ambiguous_output.exists())
            self.assertFalse(ambiguous_manifest.exists())

    def test_finalization_temporary_cleanup_is_exact_and_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archives = self.build_daily_archives(root / "archives", day_count=2)
            output = root / "run" / "prepared.jsonl"
            manifest = root / "run" / "manifest.json"
            arguments = self.prepare_arguments(archives, output, manifest)
            with mock.patch(
                "flippars_model_training.pipeline.write_prepared_dataset",
                side_effect=RuntimeError("simulated shutdown before finalization"),
            ), self.assertRaisesRegex(RuntimeError, "before finalization"):
                prepare_archives(**arguments)

            invalid_name = output.parent / ".prepared.jsonl.invalid!.part"
            invalid_name.write_text("preserve", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Ambiguous abandoned temporary name"):
                prepare_archives(**arguments)
            self.assertEqual(invalid_name.read_text(encoding="utf-8"), "preserve")
            invalid_name.unlink()

            directory_candidate = output.parent / ".prepared.jsonl.abcdefgh.part"
            directory_candidate.mkdir()
            with self.assertRaisesRegex(ValueError, "not a regular file"):
                prepare_archives(**arguments)
            self.assertTrue(directory_candidate.is_dir())
            directory_candidate.rmdir()

            symlink_source = root / "symlink-source.txt"
            symlink_source.write_text("preserve", encoding="utf-8")
            symlink_candidate = output.parent / ".prepared.jsonl.ijklmnop.part"
            try:
                symlink_candidate.symlink_to(symlink_source)
            except (NotImplementedError, OSError):
                pass
            else:
                with self.assertRaisesRegex(ValueError, "not a regular file"):
                    prepare_archives(**arguments)
                self.assertTrue(symlink_candidate.is_symlink())
                symlink_candidate.unlink()

            prepared_temporary = output.parent / ".prepared.jsonl.qrstuvwx.part"
            manifest_temporary = output.parent / ".manifest.json.1234_ab-.part"
            prepared_temporary.write_text("abandoned", encoding="utf-8")
            manifest_temporary.write_text("abandoned", encoding="utf-8")
            prepare_archives(**arguments)
            self.assertFalse(prepared_temporary.exists())
            self.assertFalse(manifest_temporary.exists())
            self.assertTrue(output.is_file())
            self.assertTrue(manifest.is_file())

    def test_checkpoint_temporary_token_length_mismatch_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archives = self.build_daily_archives(root / "archives", day_count=2)
            output = root / "run" / "prepared.jsonl"
            manifest = root / "run" / "manifest.json"
            arguments = self.prepare_arguments(archives, output, manifest)
            with self.interrupt_after_checkpoint(1), self.assertRaises(RuntimeError):
                prepare_archives(**arguments)
            malformed = (
                pipeline_module.archive_checkpoint_root(output)
                / "archives"
                / ".00000002.short.part"
            )
            malformed.mkdir()
            with self.assertRaisesRegex(ValueError, "unexpected entry"):
                prepare_archives(**arguments)
            self.assertTrue(malformed.is_dir())
            self.assertFalse(output.exists())
            self.assertFalse(manifest.exists())

    def test_fifteen_minute_reversal_resume_matches_reference(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archives = self.build_daily_archives(root / "archives", day_count=2)
            signal_type = "FIFTEEN_MINUTE_REVERSAL"
            reference_output = root / "reference" / "prepared.jsonl"
            reference_manifest = root / "reference" / "manifest.json"
            reference = self.write_reference(
                archives,
                reference_output,
                reference_manifest,
                signal_type,
            )
            output = root / "resumed" / "prepared.jsonl"
            manifest = root / "resumed" / "manifest.json"
            arguments = self.prepare_arguments(
                archives,
                output,
                manifest,
                signal_type=signal_type,
            )
            with self.interrupt_after_checkpoint(1), self.assertRaises(RuntimeError):
                prepare_archives(**arguments)
            resumed = prepare_archives(**arguments)
            self.assertEqual(output.read_bytes(), reference_output.read_bytes())
            self.assertEqual(
                resumed["datasetContentSha256"], reference["datasetContentSha256"]
            )


class AcquisitionEvidenceTests(unittest.TestCase):
    def fixture(
        self, root: Path
    ) -> tuple[Path, ArchiveReport, dict[str, object], dict[str, object]]:
        day = "2025-01-01"
        archive_name = f"BTCUSDT-trades-{day}.zip"
        checksum_name = f"{archive_name}.CHECKSUM"
        archive_uri = (
            "https://data.binance.vision/data/spot/daily/trades/"
            f"BTCUSDT/{archive_name}"
        )
        checksum_uri = f"{archive_uri}.CHECKSUM"
        archive_digest = "1" * 64
        checksum_digest = "2" * 64
        record: dict[str, object] = {
            "day": day,
            "archiveName": archive_name,
            "archiveBytes": 123,
            "archiveSha256": archive_digest,
            "checksumName": checksum_name,
            "checksumBytes": 80,
            "checksumSha256": checksum_digest,
            "expectedArchiveSha256": archive_digest,
            "archiveSourceUri": archive_uri,
            "requestedChecksumUri": checksum_uri,
            "finalChecksumUri": checksum_uri,
            "checksumRetrievedAt": "2025-01-02T00:00:00.0000000Z",
        }
        index_digest = hashlib.sha256(
            canonical_json([record]).encode("utf-8")
        ).hexdigest()
        sha_record = {
            "Path": r"C:\evidence.json",
            "Bytes": 1,
            "LastWriteTimeUtc": "2025-01-02T00:00:00.0000000Z",
            "Sha256": "3" * 64,
        }
        manifest: dict[str, object] = {
            "schemaVersion": 3,
            "completionState": "COMPLETE",
            "completedAt": "2025-01-02T00:00:01.0000000Z",
            "source": {
                "provider": "Binance Data Vision",
                "marketType": "SPOT",
                "symbol": "BTCUSDT",
                "dataKind": "DAILY_TRADES",
                "timeBasis": "EVENT_TIME",
                "cache": r"C:\cache",
            },
            "window": {
                "startInclusive": day,
                "endExclusive": "2025-01-02",
                "dayCount": 1,
            },
            "materialization": "HARD_LINK",
            "archiveRoot": r"C:\dataset\raw\archives",
            "archives": [record],
            "acquisitionArchiveIndexSha256": index_digest,
            "cacheInventoryBefore": dict(sha_record),
            "cacheInventoryAfter": dict(sha_record),
            "isolatedIntegrity": dict(sha_record),
            "freshOfficialTransportEvidence": True,
            "credentialsUsed": False,
            "tradingApiUsed": False,
        }
        path = root / "acquisition-manifest.json"
        path.write_text(
            json.dumps(manifest, separators=(",", ":")) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        report = ArchiveReport(
            archive=archive_name,
            symbol="BTCUSDT",
            day=day,
            archive_sha256=archive_digest,
            expected_sha256=archive_digest,
            member=f"BTCUSDT-trades-{day}.csv",
            archive_bytes=123,
            checksum_name=checksum_name,
            checksum_bytes=80,
            checksum_sha256=checksum_digest,
        )
        return path, report, manifest, record

    def test_schema3_acquisition_evidence_is_exactly_bound(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path, report, manifest, record = self.fixture(root)
            binding = validate_acquisition_evidence(
                path, [report], "2025-01-01", "2025-01-02"
            )
            self.assertEqual(
                binding["schemaVersion"],
                "flippars.public-binance-acquisition-binding/1",
            )
            self.assertEqual(
                binding["acquisitionManifestSha256"],
                hashlib.sha256(path.read_bytes()).hexdigest(),
            )
            self.assertEqual(binding["archives"], [record])

            uri_mutation = json.loads(json.dumps(manifest))
            uri_mutation["archives"][0]["finalChecksumUri"] = (
                "https://attacker.invalid/substituted.CHECKSUM"
            )
            uri_mutation["acquisitionArchiveIndexSha256"] = hashlib.sha256(
                canonical_json(uri_mutation["archives"]).encode("utf-8")
            ).hexdigest()
            uri_path = root / "bad-uri.json"
            uri_path.write_text(json.dumps(uri_mutation), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "identity or pinned URI"):
                validate_acquisition_evidence(
                    uri_path, [report], "2025-01-01", "2025-01-02"
                )

            order_mutation = json.loads(json.dumps(manifest))
            original = order_mutation["archives"][0]
            order_mutation["archives"][0] = {
                "archiveName": original["archiveName"],
                **{key: value for key, value in original.items() if key != "archiveName"},
            }
            order_path = root / "bad-order.json"
            order_path.write_text(json.dumps(order_mutation), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "key order"):
                validate_acquisition_evidence(
                    order_path, [report], "2025-01-01", "2025-01-02"
                )

            report.checksum_sha256 = "4" * 64
            with self.assertRaisesRegex(ValueError, "disagrees with acquisition evidence"):
                validate_acquisition_evidence(
                    path, [report], "2025-01-01", "2025-01-02"
                )


class SignalFeatureTests(unittest.TestCase):
    def complete_early_window(self) -> list[dict[str, object]]:
        rows, _ = examples_from_trades(
            synthetic_trades(20), options('FIVE_MINUTE_EARLY_DIRECTION')
        )
        window_start = rows[0]['windowStart']
        return [row for row in rows if row['windowStart'] == window_start]

    def write_training_rows(
        self, path: Path, rows: list[dict[str, object]]
    ) -> None:
        path.write_text(
            ''.join(json.dumps(row, separators=(',', ':')) + '\n' for row in rows),
            encoding='utf-8',
            newline='\n',
        )

    def test_governed_boundaries(self) -> None:
        self.assertEqual(list(decision_offsets("FIVE_MINUTE_EARLY_DIRECTION", 300, options("FIVE_MINUTE_EARLY_DIRECTION"))), [15, 30, 45])
        five = list(decision_offsets("FIVE_MINUTE_REVERSAL", 300, options("FIVE_MINUTE_REVERSAL")))
        self.assertEqual((five[0], five[-1]), (15, 285))
        fifteen = list(decision_offsets("FIFTEEN_MINUTE_REVERSAL", 900, options("FIFTEEN_MINUTE_REVERSAL")))
        self.assertEqual((fifteen[0], fifteen[-1]), (450, 870))

    def test_signal_duration_and_lead_are_bound(self) -> None:
        bad = DatasetOptions("FIFTEEN_MINUTE_REVERSAL", 5.0, 5, 15, 30)
        with self.assertRaises(ValueError):
            validate_dataset_options(bad)
        bad_lead = DatasetOptions("FIFTEEN_MINUTE_REVERSAL", 5.0, 15, 15, 15)
        with self.assertRaises(ValueError):
            validate_dataset_options(bad_lead)

    def test_partial_features_are_strictly_before_decision(self) -> None:
        trades = synthetic_trades(20)
        rows, _ = examples_from_trades(trades, options("FIVE_MINUTE_EARLY_DIRECTION"))
        row = rows[0]
        self.assertEqual(row["features"]["current_trade_count_log1p"], math.log1p(1))
        self.assertEqual(row["features"]["elapsed_ratio"], 15 / 300)
        self.assertIn("return_12_candle_bps", row["features"])

    def test_gap_poisoning_removes_dependent_examples(self) -> None:
        trades = synthetic_trades(30)
        missing_start = datetime(2026, 1, 1, tzinfo=UTC) + timedelta(seconds=15 * 300)
        filtered = [trade for trade in trades if not (missing_start <= trade.event_time < missing_start + timedelta(seconds=300))]
        rows, gaps = examples_from_trades(filtered, options("FIVE_MINUTE_EARLY_DIRECTION"))
        self.assertEqual(gaps, [missing_start])
        self.assertTrue(
            all(row["windowStart"] != format_timestamp(missing_start) for row in rows)
        )

    def test_deadband_boundaries_are_flat_and_not_silently_removed(self) -> None:
        self.assertEqual(close_relation(100.05, 100.0, 5.0), "AT_OPEN")
        self.assertEqual(close_relation(99.95, 100.0, 5.0), "AT_OPEN")
        self.assertEqual(close_relation(20050.02, 20040.0, 5.0), "AT_OPEN")
        self.assertEqual(close_relation(20029.98, 20040.0, 5.0), "AT_OPEN")
        self.assertEqual(close_relation(100.051, 100.0, 5.0), "ABOVE_OPEN")
        self.assertEqual(close_relation(99.949, 100.0, 5.0), "BELOW_OPEN")

    def test_training_row_rejects_schedule_and_ratio_tampering(self) -> None:
        rows, _ = examples_from_trades(
            synthetic_trades(20), options("FIVE_MINUTE_EARLY_DIRECTION")
        )
        valid = rows[0]
        self.assertIs(validate_training_row(valid, 1, valid["signalType"], 5.0), valid)
        off_schedule = json.loads(json.dumps(valid))
        start = datetime.fromisoformat(str(valid["windowStart"]).replace("Z", "+00:00"))
        off_schedule["decisionAt"] = format_timestamp(
            start + timedelta(seconds=16)
        )
        off_schedule["id"] = str(valid["id"]).rsplit(":", 1)[0] + ":16"
        off_schedule["features"]["elapsed_ratio"] = 16 / 300
        off_schedule["features"]["remaining_ratio"] = 1 - 16 / 300
        with self.assertRaisesRegex(ValueError, "outside the governed decision schedule"):
            validate_training_row(off_schedule, 2, valid["signalType"], 5.0)
        wrong_ratio = json.loads(json.dumps(valid))
        wrong_ratio["features"]["elapsed_ratio"] = 0.1
        with self.assertRaises(ValueError):
            validate_training_row(wrong_ratio, 3, valid["signalType"], 5.0)

        for row_number, (return_bps_value, relation, eligible) in enumerate(
            (
                (5.0, "AT_OPEN", True),
                (-5.0, "AT_OPEN", True),
                (5.000001, "ABOVE_OPEN", True),
                (-5.000001, "BELOW_OPEN", True),
            ),
            start=4,
        ):
            with self.subTest(return_bps=return_bps_value):
                boundary = json.loads(json.dumps(valid))
                boundary["features"]["current_return_from_open_bps"] = return_bps_value
                boundary["currentRelation"] = relation
                boundary["candidateEligible"] = eligible
                self.assertIs(
                    validate_training_row(
                        boundary, row_number, valid["signalType"], 5.0
                    ),
                    boundary,
                )

        relation_tamper = json.loads(json.dumps(valid))
        relation_tamper["features"]["current_return_from_open_bps"] = 5.000001
        relation_tamper["currentRelation"] = "BELOW_OPEN"
        relation_tamper["candidateEligible"] = True
        with self.assertRaisesRegex(ValueError, "does not match its measured return"):
            validate_training_row(relation_tamper, 8, valid["signalType"], 5.0)


    def test_complete_training_window_round_trips_without_change(self) -> None:
        complete = self.complete_early_window()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'prepared.jsonl'
            self.write_training_rows(path, complete)
            audit: dict[str, object] = {}
            groups = list(
                iter_training_window_groups(
                    path,
                    'FIVE_MINUTE_EARLY_DIRECTION',
                    DEFAULT_DEADBAND_BPS,
                    audit,
                )
            )
            self.assertEqual(audit["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
            self.assertEqual(audit["byteCount"], path.stat().st_size)
            self.assertEqual(audit["decisionRowCount"], len(complete))
            self.assertEqual(audit["windowCount"], 1)
            self.assertEqual(audit["firstDecisionAt"], complete[0]["decisionAt"])
            self.assertEqual(audit["lastWindowEnd"], complete[-1]["windowEnd"])
        self.assertEqual(groups, [(str(complete[0]['windowStart']), complete)])

    def test_training_corpus_requires_exact_canonical_bytes(self) -> None:
        complete = self.complete_early_window()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            noncanonical = root / "noncanonical.jsonl"
            noncanonical.write_text(
                "".join(json.dumps(row, separators=(", ", ": ")) + "\n" for row in complete),
                encoding="utf-8",
                newline="\n",
            )
            with self.assertRaisesRegex(ValueError, "canonically encoded"):
                list(
                    iter_training_window_groups(
                        noncanonical,
                        "FIVE_MINUTE_EARLY_DIRECTION",
                        DEFAULT_DEADBAND_BPS,
                    )
                )
            missing_lf = root / "missing-lf.jsonl"
            missing_lf.write_bytes(
                b"".join(
                    (canonical_json(row) + ("\n" if index < len(complete) - 1 else "")).encode()
                    for index, row in enumerate(complete)
                )
            )
            with self.assertRaisesRegex(ValueError, "must end with one LF byte"):
                list(
                    iter_training_window_groups(
                        missing_lf,
                        "FIVE_MINUTE_EARLY_DIRECTION",
                        DEFAULT_DEADBAND_BPS,
                    )
                )

    def test_training_window_rejects_each_missing_schedule_position(self) -> None:
        complete = self.complete_early_window()
        for missing_index in (0, len(complete) // 2, len(complete) - 1):
            with self.subTest(missing_index=missing_index), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'prepared.jsonl'
                self.write_training_rows(
                    path, complete[:missing_index] + complete[missing_index + 1 :]
                )
                with self.assertRaisesRegex(ValueError, 'complete governed decision schedule'):
                    list(
                        iter_training_window_groups(
                            path, 'FIVE_MINUTE_EARLY_DIRECTION', DEFAULT_DEADBAND_BPS
                        )
                    )

    def test_training_window_rejects_duplicate_and_noncanonical_ids(self) -> None:
        complete = self.complete_early_window()
        duplicate = complete[:1] + [json.loads(json.dumps(complete[0]))] + complete[1:]
        noncanonical = json.loads(json.dumps(complete))
        noncanonical[1]['id'] = str(noncanonical[1]['id']) + '-tampered'
        for name, rows in (('duplicate', duplicate), ('noncanonical', noncanonical)):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'prepared.jsonl'
                self.write_training_rows(path, rows)
                with self.assertRaises(ValueError):
                    list(
                        iter_training_window_groups(
                            path, 'FIVE_MINUTE_EARLY_DIRECTION', DEFAULT_DEADBAND_BPS
                        )
                    )


class PreparedWriterTests(unittest.TestCase):
    def prepared_rows(self) -> list[dict[str, object]]:
        start = datetime(2026, 1, 1, tzinfo=UTC)
        rows: list[dict[str, object]] = []
        for window in range(20):
            window_start = start + timedelta(seconds=window * 300)
            for offset in (15, 30, 45):
                rows.append(
                    {
                        "id": f"{window:04d}-{offset:03d}",
                        "decisionAt": format_timestamp(
                            window_start + timedelta(seconds=offset)
                        ),
                        "windowStart": format_timestamp(window_start),
                        "windowEnd": format_timestamp(
                            window_start + timedelta(seconds=300)
                        ),
                    }
                )
        return rows

    def test_streaming_writer_counts_rows_and_windows(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "prepared.jsonl"
            manifest_output = root / "manifest.json"
            result = write_prepared_dataset(
                rows=iter(self.prepared_rows()),
                trades_accepted=60,
                cross_file_duplicates=0,
                reports=[],
                gap_starts=[],
                output=output,
                manifest_output=manifest_output,
                options=options("FIVE_MINUTE_EARLY_DIRECTION"),
            )
            manifest = json.loads(manifest_output.read_text(encoding="utf-8"))
            self.assertEqual(result["rows"], 60)
            self.assertEqual(manifest["preparedDecisionRowCount"], 60)
            self.assertEqual(manifest["preparedWindowCount"], 20)
            self.assertEqual(
                manifest["partitionWindowCounts"],
                {"modelFit": 12, "calibration": 4, "evaluation": 4},
            )

    def test_manifest_is_exact_and_cannot_fabricate_public_binance_lineage(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "prepared.jsonl"
            manifest_output = root / "manifest.json"
            write_prepared_dataset(
                rows=iter(self.prepared_rows()),
                trades_accepted=60,
                cross_file_duplicates=0,
                reports=[],
                gap_starts=[],
                output=output,
                manifest_output=manifest_output,
                options=options("FIVE_MINUTE_EARLY_DIRECTION"),
            )
            manifest = json.loads(manifest_output.read_text(encoding="utf-8"))
            self.assertIs(validate_dataset_manifest(manifest), manifest)
            summary = dataset_manifest_summary(
                manifest,
                hashlib.sha256(output.read_bytes()).hexdigest(),
                hashlib.sha256(manifest_output.read_bytes()).hexdigest(),
            )
            self.assertEqual(summary["lineageKind"], "SYNTHETIC_LOCAL")
            self.assertEqual(summary["source"], "SYNTHETIC_LOCAL")
            self.assertIs(summary["archiveChecksumsVerified"], False)
            self.assertIs(summary["officialTransportEvidenceVerified"], False)
            self.assertIsNone(summary["acquisitionManifestSha256"])

            mutations: list[tuple[str, dict[str, object]]] = []
            extra = json.loads(json.dumps(manifest))
            extra["unexpected"] = True
            mutations.append(("extra root field", extra))
            boolean_count = json.loads(json.dumps(manifest))
            boolean_count["acceptedTradeCount"] = True
            mutations.append(("boolean count", boolean_count))
            feature_order = json.loads(json.dumps(manifest))
            feature_order["featureNames"] = list(reversed(feature_order["featureNames"]))
            mutations.append(("feature order", feature_order))
            source_range = json.loads(json.dumps(manifest))
            source_range["source"]["dayCount"] = 1
            mutations.append(("source range", source_range))
            public_lie = json.loads(json.dumps(manifest))
            public_lie["source"]["lineageKind"] = "PUBLIC_BINANCE_ARCHIVE"
            mutations.append(("public lineage lie", public_lie))
            acquisition_lie = json.loads(json.dumps(manifest))
            acquisition_lie["source"]["acquisitionEvidence"] = {}
            mutations.append(("official evidence on synthetic lineage", acquisition_lie))
            split_tamper = json.loads(json.dumps(manifest))
            split_tamper["partitionWindowCounts"] = {
                "modelFit": 11,
                "calibration": 5,
                "evaluation": 4,
            }
            mutations.append(("split counts", split_tamper))
            for name, mutation in mutations:
                with self.subTest(name=name), self.assertRaises(ValueError):
                    validate_dataset_manifest(mutation)

    def test_streaming_writer_cleans_partial_file_on_failure(self) -> None:
        def failing_rows():
            yield self.prepared_rows()[0]
            raise RuntimeError("injected failure")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "prepared.jsonl"
            manifest_output = root / "manifest.json"
            with self.assertRaises(RuntimeError):
                write_prepared_dataset(
                    rows=failing_rows(),
                    trades_accepted=1,
                    cross_file_duplicates=0,
                    reports=[],
                    gap_starts=[],
                    output=output,
                    manifest_output=manifest_output,
                    options=options("FIVE_MINUTE_EARLY_DIRECTION"),
                )
            self.assertFalse(output.exists())
            self.assertFalse(manifest_output.exists())
            self.assertEqual(list(root.glob("*.part")), [])

    def test_manifest_failure_removes_the_new_dataset_pair(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "prepared.jsonl"
            manifest_output = root / "manifest.json"
            with mock.patch(
                "flippars_model_training.pipeline.write_new_json",
                side_effect=OSError("injected manifest failure"),
            ):
                with self.assertRaisesRegex(OSError, "injected manifest failure"):
                    write_prepared_dataset(
                        rows=iter(self.prepared_rows()),
                        trades_accepted=60,
                        cross_file_duplicates=0,
                        reports=[],
                        gap_starts=[],
                        output=output,
                        manifest_output=manifest_output,
                        options=options("FIVE_MINUTE_EARLY_DIRECTION"),
                    )
            self.assertFalse(output.exists())
            self.assertFalse(manifest_output.exists())


class EvaluationTests(unittest.TestCase):
    def test_walk_forward_zero_fold_support_is_explicit(self) -> None:
        report = walk_forward_evaluation([])
        self.assertEqual(report["supportStatus"], "INSUFFICIENT_SUPPORT")
        self.assertEqual(report["plannedFoldCount"], 3)
        self.assertEqual(report["foldCount"], 0)
        self.assertEqual(len(report["skippedFolds"]), 3)
        self.assertTrue(
            all(fold["reason"] for fold in report["skippedFolds"])
        )

    def rows(self) -> list[dict[str, object]]:
        result: list[dict[str, object]] = []
        start = datetime(2026, 1, 1, tzinfo=UTC)
        for window in range(120):
            for offset in (15, 30, 45):
                result.append(
                    {
                        "id": f"{window}-{offset}",
                        "windowStart": format_timestamp(
                            start + timedelta(seconds=window * 300)
                        ),
                        "windowEnd": format_timestamp(
                            start + timedelta(seconds=(window + 1) * 300)
                        ),
                        "decisionAt": format_timestamp(
                            start + timedelta(seconds=window * 300 + offset)
                        ),
                        "label": CLASS_ORDER[window % 3],
                    }
                )
        return result

    def test_partitions_never_split_a_window(self) -> None:
        partitions = chronological_split(self.rows())
        sets = [{row["windowStart"] for row in partition} for partition in partitions]
        self.assertFalse(sets[0] & sets[1])
        self.assertFalse(sets[1] & sets[2])
        self.assertEqual(sum(map(len, sets)), 120)

    def test_equivalent_noncanonical_utc_text_is_normalized_but_rejected_at_boundaries(self) -> None:
        for raw in ('2026-01-01T00:00:00Z', '2026-01-01T00:00:00+00:00'):
            with self.subTest(raw=raw):
                self.assertEqual(
                    format_timestamp(parse_timestamp(raw)),
                    '2026-01-01T00:00:00.000Z',
                )
                with self.assertRaisesRegex(ValueError, 'canonical UTC timestamps'):
                    block_bootstrap_policy([], [raw])
                with self.assertRaisesRegex(ValueError, 'canonical UTC timestamps'):
                    time_block_metric_intervals(
                        [{'windowStart': raw}],
                        np.asarray([[0.8, 0.1, 0.1]]),
                        np.asarray([0]),
                    )

    def test_flat_argmax_abstains_and_first_qualified_wins(self) -> None:
        rows = [
            {
                "windowStart": "2026-01-01T00:00:00.000Z",
                "signalType": "FIVE_MINUTE_EARLY_DIRECTION",
                "candidateEligible": True,
                "sourceIntegrityHealthy": True,
                "crossVenueGuardAvailability": "UNAVAILABLE",
                "currentRelation": "AT_OPEN",
                "durationSeconds": 300,
                "features": {"remaining_ratio": 0.95},
                "label": "ABOVE_OPEN",
            },
            {
                "windowStart": "2026-01-01T00:00:00.000Z",
                "signalType": "FIVE_MINUTE_EARLY_DIRECTION",
                "candidateEligible": True,
                "sourceIntegrityHealthy": True,
                "crossVenueGuardAvailability": "UNAVAILABLE",
                "currentRelation": "ABOVE_OPEN",
                "durationSeconds": 300,
                "features": {"remaining_ratio": 0.90},
                "label": "ABOVE_OPEN",
            },
        ]
        probabilities = np.asarray([[0.10, 0.10, 0.80], [0.80, 0.10, 0.10]])
        replay = replay_policy(
            rows,
            probabilities,
            0.75,
            feature_names=("remaining_ratio",),
            ood_envelope=replay_ood(),
            require_cross_venue_guard=False,
            scope="TEST_BINANCE_CONDITIONAL",
        )
        self.assertEqual(replay["alertCount"], 1)
        self.assertEqual(replay["precision"], 1.0)

    def test_metric_bootstrap_preserves_missing_utc_days(self) -> None:
        start = datetime(2026, 1, 1, tzinfo=UTC)
        rows: list[dict[str, object]] = []
        expected: list[int] = []
        probabilities: list[list[float]] = []
        for observed_day in range(30):
            day_start = start + timedelta(days=observed_day * 2)
            for window_index in range(4):
                window_start = format_timestamp(
                    day_start + timedelta(seconds=window_index * 300)
                )
                rows.append({'windowStart': window_start})
                label = (observed_day + window_index) % len(CLASS_ORDER)
                predicted = label if observed_day < 15 else (label + 1) % len(CLASS_ORDER)
                probability = [0.1, 0.1, 0.1]
                probability[predicted] = 0.8
                expected.append(label)
                probabilities.append(probability)
        report = time_block_metric_intervals(
            rows,
            np.asarray(probabilities),
            np.asarray(expected),
            resamples=100,
        )
        self.assertEqual(report['supportStatus'], 'SUFFICIENT')
        self.assertEqual(
            report['method'], 'MOVING_BLOCK_BOOTSTRAP_CONTIGUOUS_UTC_DAYS'
        )
        self.assertEqual(report['observedCalendarDayCount'], 30)
        self.assertEqual(report['missingCalendarDayCount'], 29)
        self.assertEqual(report['resamples'], 100)
        self.assertIsNotNone(report['logLossCi95'])

    def test_block_bootstrap_is_deterministic(self) -> None:
        start = datetime(2026, 1, 1, tzinfo=UTC)
        window_starts: list[str] = []
        alerts: list[dict[str, object]] = []
        for observed_day in range(24):
            day_start = start + timedelta(days=observed_day * 2)
            predicted = CLASS_ORDER[observed_day % 2]
            actual = predicted if observed_day < 12 else CLASS_ORDER[(observed_day + 1) % 2]
            for window_index in range(5):
                window_start = format_timestamp(
                    day_start + timedelta(seconds=window_index * 300)
                )
                window_starts.append(window_start)
                if window_index < 2:
                    alerts.append(
                        {
                            'windowStart': window_start,
                            'predicted': predicted,
                            'actual': actual,
                        }
                    )
        first = block_bootstrap_policy(alerts, window_starts)
        second = block_bootstrap_policy(alerts, window_starts)
        self.assertEqual(first, second)
        self.assertEqual(first['supportStatus'], 'SUFFICIENT')
        self.assertEqual(
            first['method'], 'MOVING_BLOCK_BOOTSTRAP_CONTIGUOUS_UTC_DAYS'
        )
        self.assertEqual(first['observedCalendarDayCount'], 24)
        self.assertEqual(first['missingCalendarDayCount'], 23)
        self.assertLess(first['precisionCi95'][0], first['precisionCi95'][1])

    def test_reversal_requires_the_predicted_opposite_side(self) -> None:
        row = {
            "windowStart": "2026-01-01T00:00:00.000Z",
            "signalType": "FIVE_MINUTE_REVERSAL",
            "candidateEligible": True,
            "sourceIntegrityHealthy": True,
            "crossVenueGuardAvailability": "UNAVAILABLE",
            "currentRelation": "ABOVE_OPEN",
            "durationSeconds": 300,
            "features": {"remaining_ratio": 0.5},
            "label": "BELOW_OPEN",
        }
        replay_arguments = {
            "feature_names": ("remaining_ratio",),
            "ood_envelope": replay_ood(),
            "require_cross_venue_guard": False,
            "scope": "TEST_BINANCE_CONDITIONAL",
        }
        same_side = replay_policy(
            [row], np.asarray([[0.8, 0.1, 0.1]]), 0.75, **replay_arguments
        )
        opposite_side = replay_policy(
            [row], np.asarray([[0.1, 0.8, 0.1]]), 0.75, **replay_arguments
        )
        self.assertEqual(same_side["alertCount"], 0)
        self.assertEqual(opposite_side["alertCount"], 1)

    def test_ood_and_unavailable_production_guard_always_abstain(self) -> None:
        row = {
            "windowStart": "2026-01-01T00:00:00.000Z",
            "signalType": "FIVE_MINUTE_EARLY_DIRECTION",
            "candidateEligible": True,
            "sourceIntegrityHealthy": True,
            "crossVenueGuardAvailability": "UNAVAILABLE",
            "currentRelation": "AT_OPEN",
            "durationSeconds": 300,
            "features": {"remaining_ratio": 0.5},
            "label": "ABOVE_OPEN",
        }
        probabilities = np.asarray([[0.9, 0.05, 0.05]])
        ood = replay_policy(
            [row],
            probabilities,
            0.75,
            feature_names=("remaining_ratio",),
            ood_envelope=replay_ood(0.0, 0.4),
            require_cross_venue_guard=False,
            scope="TEST_BINANCE_CONDITIONAL",
        )
        guarded = replay_policy(
            [row],
            probabilities,
            0.75,
            feature_names=("remaining_ratio",),
            ood_envelope=replay_ood(),
            require_cross_venue_guard=True,
            scope="TEST_PRODUCTION_GUARDED",
        )
        self.assertEqual(ood["alertCount"], 0)
        self.assertEqual(ood["abstentionRowCounts"], {"OUT_OF_DISTRIBUTION": 1})
        self.assertEqual(guarded["alertCount"], 0)
        self.assertEqual(
            guarded["abstentionRowCounts"], {"CROSS_VENUE_GUARD_UNAVAILABLE": 1}
        )

    def test_window_balancing_gives_each_window_equal_total_weight(self) -> None:
        rows = [
            {"windowStart": "a"},
            {"windowStart": "b"},
            {"windowStart": "b"},
            {"windowStart": "b"},
        ]
        weights = window_balanced_weights(rows)
        self.assertAlmostEqual(float(weights[0]), float(np.sum(weights[1:])))

    def test_softmax_is_stable_for_extreme_finite_logits(self) -> None:
        probabilities = softmax(
            np.asarray([[1e300, -1e300, 0.0], [-1e300, 1e300, 0.0]], dtype=float)
        )
        self.assertTrue(np.all(np.isfinite(probabilities)))
        np.testing.assert_allclose(np.sum(probabilities, axis=1), np.ones(2))
        with self.assertRaises(ValueError):
            softmax(np.asarray([[math.inf, 0.0, 0.0]], dtype=float))

    def test_optimizer_objective_matches_finite_difference_gradient(self) -> None:
        features = np.asarray(
            [[1.0, 0.5], [-0.5, 1.5], [2.0, -1.0], [0.25, -0.75]],
            dtype=float,
        )
        expected = np.asarray([0, 1, 2, 0], dtype=int)
        one_hot = np.eye(len(CLASS_ORDER), dtype=float)[expected]
        observation_weights = np.asarray([1.0, 2.0, 0.5, 1.5], dtype=float)
        weights = np.asarray(
            [[-20.0, 5.0], [0.0, -5.0], [20.0, 0.0]], dtype=float
        )
        biases = np.asarray([5.0, -2.0, 1.0], dtype=float)
        l2 = 0.001
        objective, gradient_weights, gradient_biases = (
            multinomial_objective_and_gradient(
                features,
                expected,
                one_hot,
                observation_weights,
                weights,
                biases,
                l2,
                2,
            )
        )
        self.assertTrue(math.isfinite(objective))
        epsilon = 1e-6
        numerical_weights = np.zeros_like(weights)
        for index in np.ndindex(weights.shape):
            plus = weights.copy()
            minus = weights.copy()
            plus[index] += epsilon
            minus[index] -= epsilon
            numerical_weights[index] = (
                multinomial_objective(
                    features, expected, observation_weights, plus, biases, l2, 2
                )
                - multinomial_objective(
                    features, expected, observation_weights, minus, biases, l2, 2
                )
            ) / (2 * epsilon)
        numerical_biases = np.zeros_like(biases)
        for index in np.ndindex(biases.shape):
            plus = biases.copy()
            minus = biases.copy()
            plus[index] += epsilon
            minus[index] -= epsilon
            numerical_biases[index] = (
                multinomial_objective(
                    features, expected, observation_weights, weights, plus, l2, 2
                )
                - multinomial_objective(
                    features, expected, observation_weights, weights, minus, l2, 2
                )
            ) / (2 * epsilon)
        np.testing.assert_allclose(
            gradient_weights, numerical_weights, rtol=1e-5, atol=1e-6
        )
        np.testing.assert_allclose(
            gradient_biases, numerical_biases, rtol=1e-5, atol=1e-6
        )

    def test_optimizer_is_deterministic_and_batch_partition_invariant(self) -> None:
        features = np.asarray(
            [[-2.0, -1.0], [-1.8, -1.2], [2.0, -1.0], [1.8, -1.2], [0.0, 2.0], [0.2, 1.8]]
            * 15,
            dtype=float,
        )
        expected = np.asarray([0, 0, 1, 1, 2, 2] * 15, dtype=int)
        first = fit_multinomial(features, expected, batch_size_limit=7)
        second = fit_multinomial(features, expected, batch_size_limit=len(features))
        np.testing.assert_allclose(first[0], second[0], rtol=1e-9, atol=1e-9)
        np.testing.assert_allclose(first[1], second[1], rtol=1e-9, atol=1e-9)
        self.assertTrue(first[2]["converged"])
        self.assertGreater(len(first[2]["lossTrace"]), 1)
        objectives = [float(item["objective"]) for item in first[2]["lossTrace"]]
        self.assertTrue(
            all(right <= left + 1e-12 for left, right in zip(objectives, objectives[1:]))
        )
        self.assertTrue(math.isfinite(float(first[2]["objective"])))
        self.assertTrue(math.isfinite(float(first[2]["gradientNorm"])))
        self.assertTrue(math.isfinite(float(first[2]["gradientInfinityNorm"])))
        self.assertIn(
            first[2]["convergenceReason"],
            ("GRADIENT_NORM", "OBJECTIVE_PLATEAU_WITH_BOUNDED_GRADIENT"),
        )
        if first[2]["convergenceReason"] == "OBJECTIVE_PLATEAU_WITH_BOUNDED_GRADIENT":
            self.assertLessEqual(
                float(first[2]["gradientInfinityNorm"]),
                float(
                    first[2]["convergenceThresholds"]["plateauGradientInfinity"]
                ),
            )

    def test_optimizer_refuses_an_unfinished_fit(self) -> None:
        features = np.asarray([[-1.0], [1.0], [0.0]] * 10, dtype=float)
        expected = np.asarray([0, 1, 2] * 10, dtype=int)
        with self.assertRaisesRegex(ValueError, "failed to converge after 2 epochs"):
            fit_multinomial(features, expected, maximum_epochs=2)

    def test_pre_evaluation_policy_digest_is_cross_runtime_stable(self) -> None:
        target_preimage = '{"deadbandBps":5.0,"kind":"TARGET"}'
        fit_state_preimage = '{"temperature":1.0,"weights":[]}'
        sampling_preimage = '{"seed":20260814}'
        policy = {
            "schemaVersion": PRE_EVALUATION_POLICY_SCHEMA_VERSION,
            "canonicalization": PRE_EVALUATION_POLICY_CANONICALIZATION,
            "signalType": "FIVE_MINUTE_EARLY_DIRECTION",
            "targetJsonPreimage": target_preimage,
            "targetSha256": hashlib.sha256(target_preimage.encode()).hexdigest(),
            "featureNames": list(FEATURE_NAMES),
            "fitStateJsonPreimage": fit_state_preimage,
            "fitStateSha256": hashlib.sha256(fit_state_preimage.encode()).hexdigest(),
            "samplingJsonPreimage": sampling_preimage,
            "samplingSha256": hashlib.sha256(sampling_preimage.encode()).hexdigest(),
            "baselineSelectionPartition": "CALIBRATION",
            "selectedBaselineKind": "GLOBAL_TRAIN_CLASS_FREQUENCY",
            "confidenceThresholdDecimal": "1",
            "deadbandBpsDecimal": "5",
            "thresholdSelection": "PREDECLARED_NO_EVALUATION_ACCESS",
            "challengerSelection": "NOT_RUN",
            "evaluationUse": "REPORT_ONLY_NO_MODEL_OR_POLICY_SELECTION",
        }
        canonical = canonical_policy_json(policy)
        self.assertEqual(
            policy_digest(policy),
            "9d143ddf4831bddd0b7a1f99d0275fe5011657ee8e18087372629671bf673668",
        )
        self.assertEqual(
            canonical_policy_json(dict(reversed(list(policy.items())))), canonical
        )
        self.assertEqual(
            policy_digest(json.loads(json.dumps(policy, sort_keys=True))),
            policy_digest(policy),
        )
        lower_threshold = {**policy, "confidenceThresholdDecimal": "0.75"}
        self.assertNotEqual(policy_digest(lower_threshold), policy_digest(policy))
        with self.assertRaisesRegex(ValueError, "unexpected schema"):
            policy_digest({**policy, "unexpected": "field"})
        with self.assertRaisesRegex(ValueError, "does not match its preimage"):
            policy_digest({**policy, "targetSha256": "0" * 64})
        with self.assertRaisesRegex(ValueError, "out of range"):
            policy_digest(
                {
                    **policy,
                    "confidenceThresholdDecimal": "0.49999999999999999999",
                }
            )

        built = build_pre_evaluation_policy(
            signal_type="FIVE_MINUTE_EARLY_DIRECTION",
            target={"deadbandBps": 5.0},
            feature_names=FEATURE_NAMES,
            normalization=(np.zeros(len(FEATURE_NAMES)), np.ones(len(FEATURE_NAMES))),
            weights=np.zeros((len(CLASS_ORDER), len(FEATURE_NAMES))),
            biases=np.zeros(len(CLASS_ORDER)),
            temperature=1.0,
            ood={"method": "TEST"},
            fit_diagnostics={"converged": True},
            sampling=sampling_metadata_fixture(),
            selected_baseline_kind="GLOBAL_TRAIN_CLASS_FREQUENCY",
            confidence_threshold=1.0,
            deadband_bps=5.0,
        )
        self.assertEqual(built["schemaVersion"], PRE_EVALUATION_POLICY_SCHEMA_VERSION)
        self.assertEqual(built["confidenceThresholdDecimal"], "1")
        self.assertEqual(built["deadbandBpsDecimal"], "5")
        self.assertEqual(canonical_decimal_string(0.75), "0.75")
        policy_digest(built)

    def test_pre_evaluation_sampling_digest_excludes_holdout_class_counts(self) -> None:
        sampling = sampling_metadata_fixture()
        sampling["sampledClassWindowCounts"] = {"holdout": {"ABOVE_OPEN": 50}}
        first = pre_evaluation_sampling_contract(sampling)
        sampling["sampledClassWindowCounts"] = {"holdout": {"BELOW_OPEN": 50}}
        second = pre_evaluation_sampling_contract(sampling)
        self.assertEqual(first, second)

    def test_missing_holdout_class_is_reported_without_a_hard_gate(self) -> None:
        rows = [
            {
                "windowStart": format_timestamp(
                    datetime(2026, 1, 1, tzinfo=UTC) + timedelta(minutes=5 * index)
                ),
                "label": "ABOVE_OPEN",
            }
            for index in range(20)
        ]
        report = outcome_support_report(rows)
        self.assertEqual(report["supportStatus"], "INSUFFICIENT_SUPPORT")
        self.assertEqual(report["minimumIndependentWindowsPerClass"], 20)
        self.assertEqual(report["independentWindowCounts"]["ABOVE_OPEN"], 20)
        self.assertEqual(report["independentWindowCounts"]["BELOW_OPEN"], 0)
        self.assertEqual(report["independentWindowCounts"]["AT_OPEN"], 0)

    def test_holdout_support_preserves_twenty_window_minimum_non_blockingly(self) -> None:
        start = datetime(2026, 1, 1, tzinfo=UTC)

        def rows_per_class(count: int) -> list[dict[str, object]]:
            return [
                {
                    "windowStart": format_timestamp(
                        start + timedelta(minutes=5 * (class_index * count + index))
                    ),
                    "label": label,
                }
                for class_index, label in enumerate(CLASS_ORDER)
                for index in range(count)
            ]

        insufficient = outcome_support_report(rows_per_class(19))
        sufficient = outcome_support_report(rows_per_class(20))
        self.assertEqual(insufficient["supportStatus"], "INSUFFICIENT_SUPPORT")
        self.assertEqual(
            insufficient["insufficientIndependentWindowCounts"],
            {label: 19 for label in CLASS_ORDER},
        )
        self.assertEqual(sufficient["supportStatus"], "SUFFICIENT")
        self.assertEqual(sufficient["insufficientIndependentWindowCounts"], {})

    def test_policy_preimages_require_one_canonical_plain_object(self) -> None:
        valid = '{"a":{"b":1.0},"c":[true,null,"ASCII"]}'
        self.assertEqual(parse_canonical_preimage_object(valid, "fixture")["a"], {"b": 1.0})
        invalid = (
            '{"a":1,"a":2}',
            '{"a":2,"a":1}',
            '[]',
            'null',
            '1',
            '{"a":NaN}',
            '{"a":Infinity}',
            '{ "a":1}',
            '{"b":1,"a":2}',
        )
        for text in invalid:
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse_canonical_preimage_object(text, "fixture")

    def test_artifact_version_rejects_colon(self) -> None:
        with self.assertRaises(ValueError):
            validate_train_options(
                "FIVE_MINUTE_EARLY_DIRECTION", "bad:version", 5.0, 0.75, 120
            )


if __name__ == "__main__":
    unittest.main()

"""Safe, offline-first Binance trade collection and draft training pipeline.

The collector uses Binance Data Vision's object listing and download endpoint.
It does not use exchange credentials or trading endpoints. Raw data and model
artifacts must live outside the Git repository.

The generated artifact is a DRAFT multinomial logistic candidate compatible
with Flippars' v2 model-artifact schema. It is a baseline, not an approved
production model. Signal-specific labels and the live runtime still require
independent review before release.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import re
import shutil
import tempfile
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Iterable, Iterator, Sequence
from xml.etree import ElementTree

import numpy as np


BINANCE_DATA_VISION = "https://data.binance.vision/"
SIGNAL_TYPES = {
    "FIVE_MINUTE_REVERSAL",
    "FIFTEEN_MINUTE_REVERSAL",
    "FIVE_MINUTE_EARLY_DIRECTION",
}
CLASS_ORDER = ("ABOVE_OPEN", "BELOW_OPEN", "AT_OPEN")
FEATURE_SCHEMA_VERSION = "trade-candle-baseline/1"
LABEL_POLICY_VERSION = "candle-close-relation/1"
NORMALIZED_HEADER = (
    "event_time_utc",
    "trade_id",
    "price",
    "quantity",
    "quote_quantity",
    "is_buyer_maker",
    "source_file",
)
DATE_PATTERN = re.compile(r"(?P<symbol>[A-Z0-9]+)-trades-(?P<day>\d{4}-\d{2}-\d{2})\.zip$")


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


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
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
        print(json.dumps({"downloaded": [str(path) for path in files]}))
        return
    if args.command == "prepare":
        count = prepare_dataset(
            normalized_root=Path(args.normalized_root),
            output=Path(args.output),
            signal_type=args.signal_type,
            deadband_bps=args.deadband_bps,
            timeframe_minutes=args.timeframe_minutes,
        )
        print(json.dumps({"rows": count, "output": str(Path(args.output).resolve())}))
        return
    if args.command == "train":
        result = train_draft(
            input_path=Path(args.input),
            output_path=Path(args.output),
            evaluation_path=Path(args.evaluation_output),
            signal_type=args.signal_type,
            version=args.version,
            deadband_bps=args.deadband_bps,
            validity_days=args.validity_days,
        )
        print(json.dumps(result, indent=2))
        return
    if args.command == "all":
        raw_root = Path(args.raw_root)
        normalized_root = raw_root / "normalized"
        archives = collect_daily_archives(
            symbol=args.symbol,
            start=date.fromisoformat(args.start),
            end=date.fromisoformat(args.end),
            raw_root=raw_root,
            base_url=args.base_url,
            overwrite=args.overwrite,
            max_files=args.max_files,
        )
        normalized_count = 0
        for archive in archives:
            normalized_count += normalize_archive(archive, normalized_root)
        prepared = Path(args.prepared_output)
        row_count = prepare_dataset(
            normalized_root=normalized_root,
            output=prepared,
            signal_type=args.signal_type,
            deadband_bps=args.deadband_bps,
            timeframe_minutes=args.timeframe_minutes,
        )
        trained = train_draft(
            input_path=prepared,
            output_path=Path(args.artifact_output),
            evaluation_path=Path(args.evaluation_output),
            signal_type=args.signal_type,
            version=args.version,
            deadband_bps=args.deadband_bps,
            validity_days=args.validity_days,
        )
        print(
            json.dumps(
                {
                    "archives": [str(path) for path in archives],
                    "normalizedTrades": normalized_count,
                    "preparedRows": row_count,
                    "artifact": trained,
                },
                indent=2,
            )
        )
        return
    parser.error("Unknown command")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    collect = commands.add_parser("collect", help="Download Binance daily trade archives.")
    collect.add_argument("--symbol", default="BTCUSDT")
    collect.add_argument("--start", required=True, help="Inclusive UTC date, YYYY-MM-DD")
    collect.add_argument("--end", required=True, help="Exclusive UTC date, YYYY-MM-DD")
    collect.add_argument("--raw-root", required=True)
    collect.add_argument("--base-url", default=BINANCE_DATA_VISION)
    collect.add_argument("--max-files", type=int, default=31)
    collect.add_argument("--overwrite", action="store_true")
    collect.set_defaults(handler=True)

    prepare = commands.add_parser("prepare", help="Build point-in-time candle rows from normalized trades.")
    prepare.add_argument("--normalized-root", required=True)
    prepare.add_argument("--output", required=True)
    prepare.add_argument("--signal-type", choices=sorted(SIGNAL_TYPES), required=True)
    prepare.add_argument("--deadband-bps", type=float, default=5.0)
    prepare.add_argument("--timeframe-minutes", type=int, default=5)

    train = commands.add_parser("train", help="Train a draft multinomial artifact.")
    train.add_argument("--input", required=True)
    train.add_argument("--output", required=True)
    train.add_argument("--evaluation-output", required=True)
    train.add_argument("--signal-type", choices=sorted(SIGNAL_TYPES), required=True)
    train.add_argument("--version", required=True)
    train.add_argument("--deadband-bps", type=float, default=5.0)
    train.add_argument("--validity-days", type=int, default=30)

    all_command = commands.add_parser("all", help="Collect, normalize, prepare, train, and evaluate.")
    all_command.add_argument("--symbol", default="BTCUSDT")
    all_command.add_argument("--start", required=True)
    all_command.add_argument("--end", required=True)
    all_command.add_argument("--raw-root", required=True)
    all_command.add_argument("--prepared-output", required=True)
    all_command.add_argument("--artifact-output", required=True)
    all_command.add_argument("--evaluation-output", required=True)
    all_command.add_argument("--signal-type", choices=sorted(SIGNAL_TYPES), required=True)
    all_command.add_argument("--version", required=True)
    all_command.add_argument("--base-url", default=BINANCE_DATA_VISION)
    all_command.add_argument("--max-files", type=int, default=31)
    all_command.add_argument("--deadband-bps", type=float, default=5.0)
    all_command.add_argument("--timeframe-minutes", type=int, default=5)
    all_command.add_argument("--validity-days", type=int, default=30)
    all_command.add_argument("--overwrite", action="store_true")
    return parser


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
    symbol = symbol.upper()
    if not re.fullmatch(r"[A-Z0-9]{3,20}", symbol):
        raise ValueError("symbol must contain only uppercase letters and digits")
    if end <= start:
        raise ValueError("end must be later than start")
    requested_days = (end - start).days
    if requested_days > max_files:
        raise ValueError(f"requested {requested_days} files, exceeding --max-files={max_files}")
    prefix = f"data/spot/daily/trades/{symbol}/"
    keys = list_listing_keys(base_url, prefix)
    archive_root = raw_root / "archives"
    archive_root.mkdir(parents=True, exist_ok=True)
    results: list[Path] = []
    for key in keys:
        match = DATE_PATTERN.search(key)
        if match is None or match.group("symbol") != symbol:
            continue
        day = date.fromisoformat(match.group("day"))
        if not (start <= day < end):
            continue
        target = archive_root / Path(key).name
        if target.exists() and not overwrite:
            results.append(target)
            continue
        download_atomic(join_url(base_url, key), target)
        results.append(target)
    expected = {(start + timedelta(days=offset)).isoformat() for offset in range(requested_days)}
    found = {DATE_PATTERN.search(path.name).group("day") for path in results if DATE_PATTERN.search(path.name)}
    missing = sorted(expected - found)
    if missing:
        raise RuntimeError(f"Binance listing did not contain requested dates: {', '.join(missing)}")
    return sorted(results)


def list_listing_keys(base_url: str, prefix: str) -> Iterator[str]:
    query = urllib.parse.urlencode({"prefix": prefix})
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/?{query}",
        headers={"User-Agent": "Flippars-data-collector/0.1"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        document = ElementTree.fromstring(response.read())
    for element in document.iter():
        if element.tag.rsplit("}", 1)[-1] == "Key" and element.text:
            yield element.text


def download_atomic(url: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=target.parent, suffix=".part", delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "Flippars-data-collector/0.1"})
        with urllib.request.urlopen(request, timeout=120) as response, temporary_path.open("wb") as output:
            shutil.copyfileobj(response, output)
        temporary_path.replace(target)
    finally:
        temporary_path.unlink(missing_ok=True)


def normalize_archive(archive_path: Path, normalized_root: Path) -> int:
    normalized_root.mkdir(parents=True, exist_ok=True)
    target = normalized_root / f"{archive_path.stem}.csv"
    if target.exists():
        return sum(1 for _ in read_normalized_trades(target))
    temporary = target.with_suffix(".csv.part")
    count = 0
    with zipfile.ZipFile(archive_path) as archive, temporary.open("w", newline="", encoding="utf-8") as output:
        writer = csv.writer(output)
        writer.writerow(NORMALIZED_HEADER)
        for member in archive.infolist():
            if member.is_dir():
                continue
            with archive.open(member) as raw:
                text = io.TextIOWrapper(raw, encoding="utf-8", newline="")
                reader = csv.reader(text)
                first = next(reader, None)
                if first is None:
                    continue
                rows: Iterable[list[str]] = reader if looks_like_header(first) else _prepend(first, reader)
                for row in rows:
                    trade = parse_trade_row(row, archive_path.name)
                    if trade is None:
                        continue
                    writer.writerow(
                        [
                            trade.event_time.isoformat().replace("+00:00", "Z"),
                            trade.trade_id,
                            format(trade.price, ".17g"),
                            format(trade.quantity, ".17g"),
                            format(trade.quote_quantity, ".17g"),
                            "true" if trade.is_buyer_maker else "false",
                            trade.source_file,
                        ]
                    )
                    count += 1
                text.detach()
    temporary.replace(target)
    return count


def _prepend(first: list[str], rows: Iterable[list[str]]) -> Iterator[list[str]]:
    yield first
    yield from rows


def looks_like_header(row: Sequence[str]) -> bool:
    normalized = {cell.strip().lower().replace(" ", "_") for cell in row}
    return "price" in normalized and ("time" in normalized or "timestamp" in normalized)


def parse_trade_row(row: Sequence[str], source_file: str) -> Trade | None:
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
        timestamp_value = float(timestamp)
        if timestamp_value > 10_000_000_000:
            timestamp_value /= 1_000
        event_time = datetime.fromtimestamp(timestamp_value, tz=UTC)
        price_value = float(price)
        quantity_value = float(quantity)
        quote_value = float(quote_quantity)
        if not all(math.isfinite(value) and value >= 0 for value in (price_value, quantity_value, quote_value)):
            return None
        return Trade(
            event_time=event_time,
            trade_id=trade_id,
            price=price_value,
            quantity=quantity_value,
            quote_quantity=quote_value,
            is_buyer_maker=maker.lower() in {"true", "1"},
            source_file=source_file,
        )
    except (TypeError, ValueError, OverflowError):
        return None


def _looks_like_timestamp(value: str) -> bool:
    try:
        number = float(value)
    except ValueError:
        return False
    return number > 1_000_000_000


def read_normalized_trades(normalized_path: Path) -> Iterator[Trade]:
    with normalized_path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            if not row:
                continue
            try:
                yield Trade(
                    event_time=datetime.fromisoformat(str(row["event_time_utc"]).replace("Z", "+00:00")),
                    trade_id=str(row["trade_id"]),
                    price=float(row["price"]),
                    quantity=float(row["quantity"]),
                    quote_quantity=float(row["quote_quantity"]),
                    is_buyer_maker=str(row["is_buyer_maker"]).lower() == "true",
                    source_file=str(row["source_file"]),
                )
            except (KeyError, TypeError, ValueError):
                continue


def prepare_dataset(
    *,
    normalized_root: Path,
    output: Path,
    signal_type: str,
    deadband_bps: float,
    timeframe_minutes: int,
) -> int:
    validate_training_options(signal_type, deadband_bps, timeframe_minutes)
    trades = (trade for path in sorted(normalized_root.glob("*.csv")) for trade in read_normalized_trades(path))
    candles = aggregate_candles(trades, timeframe_minutes)
    rows = list(examples_from_candles(candles, signal_type, deadband_bps))
    if len(rows) < 60:
        raise ValueError(f"At least 60 prepared rows are required; found {len(rows)}")
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")
    return len(rows)


def aggregate_candles(trades: Iterable[Trade], timeframe_minutes: int) -> list[Candle]:
    bucket_seconds = timeframe_minutes * 60
    candles: list[Candle] = []
    current: Candle | None = None
    for trade in trades:
        timestamp = int(trade.event_time.timestamp())
        bucket_start = datetime.fromtimestamp(timestamp - timestamp % bucket_seconds, tz=UTC)
        bucket_end = bucket_start + timedelta(minutes=timeframe_minutes)
        if current is None or bucket_start != current.start:
            if current is not None:
                candles.append(current)
            current = Candle(
                start=bucket_start,
                end=bucket_end,
                open=trade.price,
                high=trade.price,
                low=trade.price,
                close=trade.price,
                volume=trade.quantity,
                buy_volume=0.0 if trade.is_buyer_maker else trade.quantity,
                sell_volume=trade.quantity if trade.is_buyer_maker else 0.0,
                trade_count=1,
            )
            continue
        current.high = max(current.high, trade.price)
        current.low = min(current.low, trade.price)
        current.close = trade.price
        current.volume += trade.quantity
        if trade.is_buyer_maker:
            current.sell_volume += trade.quantity
        else:
            current.buy_volume += trade.quantity
        current.trade_count += 1
    if current is not None:
        candles.append(current)
    return candles


def examples_from_candles(candles: Sequence[Candle], signal_type: str, deadband_bps: float) -> Iterator[dict[str, object]]:
    for previous, target in zip(candles, candles[1:]):
        if previous.close <= 0 or target.open <= 0:
            continue
        return_bps = (previous.close / previous.open - 1) * 10_000
        range_bps = (previous.high - previous.low) / previous.open * 10_000
        relation = close_relation(target.close, target.open, deadband_bps)
        yield {
            "id": f"BTCUSDT:{target.start.isoformat()}:{signal_type}",
            "signalType": signal_type,
            "decisionAt": target.start.isoformat().replace("+00:00", "Z"),
            "windowStart": target.start.isoformat().replace("+00:00", "Z"),
            "windowEnd": target.end.isoformat().replace("+00:00", "Z"),
            "features": {
                "previous_return_bps": finite_number(return_bps),
                "previous_range_bps": finite_number(range_bps),
                "previous_volume_log1p": finite_number(math.log1p(previous.volume)),
                "previous_trade_count_log1p": finite_number(math.log1p(previous.trade_count)),
                "previous_buy_ratio": finite_number(previous.buy_volume / max(previous.volume, 1e-12)),
                "previous_close_location": finite_number(
                    (previous.close - previous.low) / max(previous.high - previous.low, 1e-12)
                ),
            },
            "label": relation,
            "dataHealthy": True,
            "anomalyRisk": 0.0,
        }


def close_relation(close: float, open_price: float, deadband_bps: float) -> str:
    return_bps = (close / open_price - 1) * 10_000
    if return_bps > deadband_bps:
        return "ABOVE_OPEN"
    if return_bps < -deadband_bps:
        return "BELOW_OPEN"
    return "AT_OPEN"


def finite_number(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return value


def train_draft(
    *,
    input_path: Path,
    output_path: Path,
    evaluation_path: Path,
    signal_type: str,
    version: str,
    deadband_bps: float,
    validity_days: int,
) -> dict[str, object]:
    validate_training_options(signal_type, deadband_bps, 5)
    rows = [json.loads(line) for line in input_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    rows = [row for row in rows if row.get("signalType") == signal_type and row.get("dataHealthy") and row.get("anomalyRisk", 1) < 0.65]
    rows.sort(key=lambda row: str(row["decisionAt"]))
    if len(rows) < 60:
        raise ValueError(f"At least 60 healthy rows are required; found {len(rows)}")
    feature_names = sorted(rows[0]["features"])
    if any(sorted(row.get("features", {})) != feature_names for row in rows):
        raise ValueError("All rows must use the same feature schema")
    train_end = int(len(rows) * 0.6)
    calibration_end = int(len(rows) * 0.8)
    train_rows = rows[:train_end]
    calibration_rows = rows[train_end:calibration_end]
    holdout_rows = rows[calibration_end:]
    if min(len(train_rows), len(calibration_rows), len(holdout_rows)) < 5:
        raise ValueError("Chronological partitions are too small")
    means = np.asarray([np.mean([float(row["features"][name]) for row in train_rows]) for name in feature_names], dtype=float)
    scales = np.asarray(
        [max(float(np.std([float(row["features"][name]) for row in train_rows])), 1e-9) for name in feature_names],
        dtype=float,
    )
    train_x = feature_matrix(train_rows, feature_names, means, scales)
    calibration_x = feature_matrix(calibration_rows, feature_names, means, scales)
    holdout_x = feature_matrix(holdout_rows, feature_names, means, scales)
    train_y = labels(train_rows)
    calibration_y = labels(calibration_rows)
    holdout_y = labels(holdout_rows)
    weights, biases = fit_multinomial(train_x, train_y)
    calibration_logits = calibration_x @ weights.T + biases
    temperature = fit_temperature(calibration_logits, calibration_y)
    holdout_probabilities = softmax((holdout_x @ weights.T + biases) / temperature)
    evaluation = evaluate(holdout_probabilities, holdout_y)
    created_at = datetime.now(tz=UTC)
    trained_through = datetime.fromisoformat(str(train_rows[-1]["decisionAt"]).replace("Z", "+00:00"))
    artifact = {
        "schemaVersion": "flippars.multinomial-candidate/2",
        "artifactId": f"candidate:{signal_type}:{version}",
        "version": version,
        "status": "DRAFT",
        "signalType": signal_type,
        "target": {
            "kind": "CANDLE_CLOSE_RELATION",
            "classOrder": list(CLASS_ORDER),
            "deadbandBps": deadband_bps,
            "labelPolicyVersion": LABEL_POLICY_VERSION,
        },
        "createdAt": created_at.isoformat().replace("+00:00", "Z"),
        "trainedThrough": trained_through.isoformat().replace("+00:00", "Z"),
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "featureNames": feature_names,
        "normalization": {"means": means.tolist(), "scales": scales.tolist()},
        "model": {
            "kind": "MULTINOMIAL_LOGISTIC",
            "weights": weights.tolist(),
            "biases": biases.tolist(),
        },
        "calibration": {
            "method": "TEMPERATURE",
            "temperature": temperature,
            "version": f"temperature:{version}",
            "validUntil": (created_at + timedelta(days=validity_days)).isoformat().replace("+00:00", "Z"),
        },
        "datasetSha256": sha256_file(input_path),
        "trainingCodeSha256": sha256_file(Path(__file__)),
        "approval": {"approvedAt": None, "approvedBy": None},
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    write_new_json(output_path, artifact)
    evaluation_payload = {
        "status": "DRAFT",
        "signalType": signal_type,
        "version": version,
        "rows": {"total": len(rows), "train": len(train_rows), "calibration": len(calibration_rows), "holdout": len(holdout_rows)},
        "featureNames": feature_names,
        "temperature": temperature,
        "holdout": evaluation,
        "warning": "Baseline artifact only; not approved, registered, or production-ready.",
    }
    write_new_json(evaluation_path, evaluation_payload)
    return {"artifact": str(output_path.resolve()), "evaluation": str(evaluation_path.resolve()), "holdout": evaluation}


def feature_matrix(rows: Sequence[dict[str, object]], names: Sequence[str], means: np.ndarray, scales: np.ndarray) -> np.ndarray:
    values = np.asarray([[float(row["features"][name]) for name in names] for row in rows], dtype=float)
    return (values - means) / scales


def labels(rows: Sequence[dict[str, object]]) -> np.ndarray:
    mapping = {name: index for index, name in enumerate(CLASS_ORDER)}
    return np.asarray([mapping[str(row["label"])] for row in rows], dtype=int)


def fit_multinomial(features: np.ndarray, expected: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    class_count = len(CLASS_ORDER)
    weights = np.zeros((class_count, features.shape[1]), dtype=float)
    biases = np.zeros(class_count, dtype=float)
    one_hot = np.eye(class_count, dtype=float)[expected]
    rate = 0.05
    l2 = 0.001
    for _ in range(2_000):
        probabilities = softmax(features @ weights.T + biases)
        error = probabilities - one_hot
        weights -= rate * ((error.T @ features) / len(features) + l2 * weights)
        biases -= rate * np.mean(error, axis=0)
    return weights, biases


def softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - np.max(logits, axis=1, keepdims=True)
    exponentials = np.exp(np.clip(shifted, -60, 60))
    return exponentials / np.sum(exponentials, axis=1, keepdims=True)


def fit_temperature(logits: np.ndarray, expected: np.ndarray) -> float:
    candidates = np.exp(np.linspace(math.log(0.25), math.log(4.0), 96))
    losses = [multiclass_log_loss(softmax(logits / candidate), expected) for candidate in candidates]
    return float(candidates[int(np.argmin(losses))])


def multiclass_log_loss(probabilities: np.ndarray, expected: np.ndarray) -> float:
    selected = np.clip(probabilities[np.arange(len(expected)), expected], 1e-9, 1.0)
    return float(-np.mean(np.log(selected)))


def evaluate(probabilities: np.ndarray, expected: np.ndarray) -> dict[str, object]:
    predictions = np.argmax(probabilities, axis=1)
    brier = float(np.mean(np.sum((probabilities - np.eye(len(CLASS_ORDER))[expected]) ** 2, axis=1)))
    per_class: dict[str, dict[str, float | int]] = {}
    for index, name in enumerate(CLASS_ORDER):
        actual = expected == index
        predicted = predictions == index
        true_positive = int(np.sum(actual & predicted))
        precision = true_positive / max(int(np.sum(predicted)), 1)
        recall = true_positive / max(int(np.sum(actual)), 1)
        per_class[name] = {
            "count": int(np.sum(actual)),
            "precision": precision,
            "recall": recall,
        }
    return {
        "sampleCount": int(len(expected)),
        "accuracy": float(np.mean(predictions == expected)),
        "brierScore": brier,
        "logLoss": multiclass_log_loss(probabilities, expected),
        "classMetrics": per_class,
    }


def validate_training_options(signal_type: str, deadband_bps: float, timeframe_minutes: int) -> None:
    if signal_type not in SIGNAL_TYPES:
        raise ValueError(f"Unsupported signal type: {signal_type}")
    if not math.isfinite(deadband_bps) or not 0 <= deadband_bps <= 100:
        raise ValueError("deadband-bps must be between 0 and 100")
    if timeframe_minutes not in {5, 15}:
        raise ValueError("timeframe-minutes must be 5 or 15")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1_048_576), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_new_json(path: Path, value: object) -> None:
    if path.exists():
        raise FileExistsError(f"Refusing to overwrite existing file: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")


def join_url(base_url: str, key: str) -> str:
    return f"{base_url.rstrip('/')}/{urllib.parse.quote(key, safe='/')}"

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


@dataclass(frozen=True)
class ArchiveTimeRange:
    date_from: Optional[date]
    date_to: Optional[date]
    start_at: Optional[datetime]
    end_at: Optional[datetime]
    timezone_name: str

    def contains(self, timestamp: Optional[datetime]) -> bool:
        if timestamp is None:
            return False
        normalized = timestamp.replace(tzinfo=timezone.utc) if timestamp.tzinfo is None else (
            timestamp.astimezone(timezone.utc)
        )
        if self.start_at and normalized < self.start_at:
            return False
        return not self.end_at or normalized < self.end_at

    def payload(self) -> dict:
        return {
            "date_from": self.date_from.isoformat() if self.date_from else None,
            "date_to": self.date_to.isoformat() if self.date_to else None,
            "start_at": self.start_at.isoformat() if self.start_at else None,
            "end_at": self.end_at.isoformat() if self.end_at else None,
            "timezone_name": self.timezone_name,
        }


def resolve_archive_time_range(
    date_from: Optional[date], date_to: Optional[date], timezone_name: str,
) -> Optional[ArchiveTimeRange]:
    if date_from is None and date_to is None:
        return None
    if date_from and date_to and date_from > date_to:
        raise ValueError("Archive date_from must not be after date_to.")
    zone = validated_zone(timezone_name)
    start_at = _local_midnight(date_from, zone) if date_from else None
    end_at = _local_midnight(date_to + timedelta(days=1), zone) if date_to else None
    return ArchiveTimeRange(
        date_from, date_to,
        start_at.astimezone(timezone.utc) if start_at else None,
        end_at.astimezone(timezone.utc) if end_at else None,
        timezone_name,
    )


def workspace_now(timezone_name: str) -> datetime:
    return datetime.now(validated_zone(timezone_name))


def validated_zone(timezone_name: str) -> ZoneInfo:
    try:
        return ZoneInfo(timezone_name)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise ValueError("Workspace timezone must be a valid IANA timezone.") from error


def _local_midnight(value: date, zone: ZoneInfo) -> datetime:
    return datetime.combine(value, time.min, tzinfo=zone)

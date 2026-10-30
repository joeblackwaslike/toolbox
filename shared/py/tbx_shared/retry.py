from collections.abc import Callable

from tenacity import Retrying, retry_if_exception_type, stop_after_attempt, wait_exponential


def retry_policy(
    attempts: int = 3,
    base: float = 0.5,
    max_wait: float = 10.0,
    retry_on: tuple[type[BaseException], ...] = (OSError,),
) -> Retrying:
    """Build a Tenacity policy: stop after ``attempts``, exponential wait capped, reraise."""
    return Retrying(
        stop=stop_after_attempt(attempts),
        wait=wait_exponential(multiplier=base, max=max_wait),
        retry=retry_if_exception_type(retry_on),
        reraise=True,
    )


def with_retry[**P, R](fn: Callable[P, R], policy: Retrying | None = None) -> Callable[P, R]:
    """Wrap ``fn`` so each call runs under ``policy`` (default ``retry_policy()``)."""
    active = policy or retry_policy()

    def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
        return active(fn, *args, **kwargs)

    return wrapper

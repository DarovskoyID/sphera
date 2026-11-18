"""Rate limiting for the bot runtime API.

Two buckets, chosen per bot from its ``api_tier``:

* **standard** — the free tier, sized for ordinary bot traffic;
* **premium** — a higher-rate tier that lets a bot push load well above the
  standard ceiling (a paid upgrade).

Both classes are safe to install globally in ``DEFAULT_THROTTLE_CLASSES``:
``BotRateThrottle`` only acts on requests authenticated by a bot token (it keys
off ``request.bot_account``, set by :class:`sfera_bots.auth.BotTokenAuthentication`)
and lets everything else through untouched, while ``BotAwareUserRateThrottle``
is the ordinary per-user throttle with bots carved out — so a premium bot's
higher allowance is not clipped by the generic ``user`` rate.

Every decision is counted (total / per-tier / throttled) so the load shows up on
the Grafana API dashboard.
"""

from rest_framework.throttling import SimpleRateThrottle, UserRateThrottle

from sfera_server import metrics


class BotRateThrottle(SimpleRateThrottle):
    # Real scope is picked per-request from the bot's tier; this default only
    # decides which rate SimpleRateThrottle reads at construction time.
    scope = 'bot_standard'

    def allow_request(self, request, view):
        bot = getattr(request, 'bot_account', None)
        if bot is None:
            # Not a bot-authenticated request — this throttle doesn't apply.
            return True

        tier = getattr(bot, 'api_tier', BOT_TIER_STANDARD)
        self.scope = 'bot_premium' if tier == 'premium' else 'bot_standard'
        self.rate = self.get_rate()
        self.num_requests, self.duration = self.parse_rate(self.rate)

        allowed = super().allow_request(request, view)

        try:
            metrics.inc('bot_api_requests_total')
            metrics.inc('bot_api_requests_premium' if tier == 'premium' else 'bot_api_requests_standard')
            if not allowed:
                metrics.inc('bot_api_throttled_total')
        except Exception:
            pass
        return allowed

    def get_cache_key(self, request, view):
        bot = getattr(request, 'bot_account', None)
        if bot is None:
            return None  # skip — nothing to throttle
        # One shared bucket per bot, regardless of which endpoint it hits.
        return f'throttle_bot_{bot.id}'


class BotAwareUserRateThrottle(UserRateThrottle):
    """The stock per-user throttle, but never applied to bot API traffic — bots
    are governed by :class:`BotRateThrottle` and must not also be clipped by the
    generic ``user`` rate (which would cap a premium bot below its tier)."""

    def allow_request(self, request, view):
        if getattr(request, 'bot_account', None) is not None:
            return True
        return super().allow_request(request, view)


BOT_TIER_STANDARD = 'standard'

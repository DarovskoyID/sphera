# Shared in-memory voice channel state.
# Stored here (not in consumers.py) to avoid circular imports between views and consumers.
# Structure: { channel_id: { '_guild_id': int, user_id: user_info_dict, ... } }
_voice_channels: dict = {}

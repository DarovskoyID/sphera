use jsonwebtoken::{decode, DecodingKey, Validation, Algorithm};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Claims {
    pub user_id: String,
    pub exp: usize,
}

pub fn validate_token(token: &str, secret: &str) -> Option<Claims> {
    // Django SimpleJWT uses HS256 by default
    let mut validation = Validation::new(Algorithm::HS256);
    // Don't validate aud — Django doesn't set it
    validation.validate_aud = false;

    let key = DecodingKey::from_secret(secret.as_bytes());
    match decode::<Claims>(token, &key, &validation) {
        Ok(data) => Some(data.claims),
        Err(e) => {
            tracing::debug!("JWT validation failed: {}", e);
            None
        }
    }
}

//! A typed request surface over one session.

use serde::Serialize;
use serde::de::DeserializeOwned;

use serde_json::json;

use crate::catalog::Catalog;
use crate::error::{RemoteError, codes};
use crate::session::{RequestOptions, Session};
use crate::validate::RPC_DISCOVER;

/// A typed request surface over one [`Session`], from [`super::Contract::client`].
///
/// Neither `request` nor `request_with` checks `method` against the
/// contract locally before sending — the peer's own dispatch is the check,
/// exactly as the TypeScript SDK's `ContractClient` relies purely on a
/// compile-time method-name type, which has no runtime equivalent here.
pub struct ContractClient<'a> {
    session: &'a Session,
}

impl<'a> ContractClient<'a> {
    pub(super) fn new(session: &'a Session) -> Self {
        Self { session }
    }

    /// Sends `params`, serialised to the wire, and decodes the peer's result
    /// as `R`. Equivalent to `request_with` with the defaults.
    ///
    /// # Errors
    /// Whatever [`Session::request`] returns, plus `INTERNAL` if `params`
    /// fails to serialise or the peer's result fails to decode as `R`.
    pub async fn request<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &str,
        params: P,
    ) -> Result<R, RemoteError> {
        self.request_with(method, params, RequestOptions::default())
            .await
    }

    /// Asks the peer for the contract it serves (`rpc.discover`, §6.4),
    /// decodes the answer as a [`Catalog`] and validates it.
    ///
    /// The catalog is the peer's, not this side's; a caller that intends to
    /// compile it into a [`super::Contract`] still does so with
    /// [`super::Contract::from_catalog`], which runs the same checks against
    /// the already-validated document.
    ///
    /// # Errors
    /// `INVALID_REQUEST` against a peer below wire minor 1,
    /// `METHOD_UNSUPPORTED` when the peer serves no contract, and `INTERNAL`
    /// when what came back is not a catalog document or fails
    /// [`Catalog::validate`].
    pub async fn discover(&self) -> Result<Catalog, RemoteError> {
        self.discover_with(RequestOptions::default()).await
    }

    /// [`ContractClient::discover`], tuned by `options`.
    ///
    /// # Errors
    /// The same as [`ContractClient::discover`], plus `INTERNAL` when the
    /// catalog decodes but fails [`Catalog::validate`] — a constraint Serde
    /// cannot express, the same check the TypeScript SDK's `assertCatalog`
    /// runs on its side of this call.
    pub async fn discover_with(&self, options: RequestOptions) -> Result<Catalog, RemoteError> {
        let catalog: Catalog = self.request_with(RPC_DISCOVER, json!({}), options).await?;
        catalog.validate().map_err(|error| {
            RemoteError::new(
                codes::INTERNAL,
                format!(
                    "The peer's catalog does not satisfy the checks Serde cannot express: {error}."
                ),
            )
        })?;
        Ok(catalog)
    }

    /// [`ContractClient::request`], tuned by `options`.
    ///
    /// # Errors
    /// The same as [`ContractClient::request`].
    pub async fn request_with<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &str,
        params: P,
        options: RequestOptions,
    ) -> Result<R, RemoteError> {
        let params = serde_json::to_value(params).map_err(|error| {
            RemoteError::new(
                codes::INTERNAL,
                format!("Parameters of \"{method}\" failed to serialise: {error}."),
            )
            .with_detail("method", method.to_string())
        })?;
        let result = self.session.request_with(method, params, options).await?;
        serde_json::from_value(result).map_err(|error| {
            RemoteError::new(
                codes::INTERNAL,
                format!(
                    "Result of \"{method}\" from the peer does not decode as the requested \
                     type: {error}."
                ),
            )
            .with_detail("method", method.to_string())
        })
    }
}

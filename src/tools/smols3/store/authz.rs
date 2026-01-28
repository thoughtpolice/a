// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Cedar-based authorization for smols3.
//!
//! This module provides fine-grained access control using Cedar policies.
//! It integrates with s3s's `S3Access` trait to authorize S3 operations
//! based on configurable policies.
//!
//! # Cedar Entity Model
//!
//! S3 concepts are mapped to Cedar entity types:
//!
//! | Cedar Entity Type | S3 Concept | Identifier |
//! |-------------------|------------|------------|
//! | `SmolS3::User` | Authenticated user | access_key |
//! | `SmolS3::Bucket` | S3 bucket | bucket name |
//! | `SmolS3::Object` | S3 object | `bucket/key` |
//! | `SmolS3::Service` | Service root | "smols3" |
//!
//! # Entity Hierarchy
//!
//! - Objects have parent Buckets
//! - Buckets have parent Service
//!
//! # Example Policies
//!
//! Allow full access to admin user:
//! ```cedar
//! permit(
//!     principal == SmolS3::User::"AKIAADMINKEY",
//!     action,
//!     resource
//! );
//! ```
//!
//! Read-only access to specific bucket:
//! ```cedar
//! permit(
//!     principal == SmolS3::User::"AKIAREADONLY",
//!     action in [
//!         SmolS3::Action::"s3:GetObject",
//!         SmolS3::Action::"s3:HeadObject",
//!         SmolS3::Action::"s3:ListBucket"
//!     ],
//!     resource in SmolS3::Bucket::"public-data"
//! );
//! ```

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use cedar_policy::{
    Authorizer, Context, Decision, Entities, Entity, EntityId, EntityTypeName, EntityUid,
    ParseErrors, PolicySet, Request, RestrictedExpression,
};
use s3s::access::{S3Access, S3AccessContext};
use s3s::path::S3Path;
use s3s::S3Result;

/// Cedar-based authorizer for S3 operations.
///
/// Evaluates Cedar policies to determine whether requests are authorized.
/// Implements the s3s `S3Access` trait for integration with the S3 service.
pub struct CedarAuthorizer {
    authorizer: Authorizer,
    policies: Arc<PolicySet>,
}

impl CedarAuthorizer {
    /// Create a new authorizer from a Cedar policy string.
    ///
    /// # Errors
    ///
    /// Returns an error if the policy string cannot be parsed.
    pub fn from_policy_str(policy_src: &str) -> Result<Self, ParseErrors> {
        let policies = policy_src.parse::<PolicySet>()?;
        Ok(Self {
            authorizer: Authorizer::new(),
            policies: Arc::new(policies),
        })
    }

    /// Evaluate whether the request is authorized.
    fn evaluate(&self, principal: Option<&str>, action: &str, path: &S3Path) -> bool {
        let principal_uid = make_principal_uid(principal);
        let action_uid = make_action_uid(action);
        let resource_uid = make_resource_uid(path);
        let entities = build_entities(principal, path);

        let request = Request::new(
            principal_uid,
            action_uid,
            resource_uid,
            Context::empty(),
            None,
        )
        .expect("request construction should not fail");

        let response = self
            .authorizer
            .is_authorized(&request, &self.policies, &entities);
        response.decision() == Decision::Allow
    }
}

#[async_trait::async_trait]
impl S3Access for CedarAuthorizer {
    async fn check(&self, cx: &mut S3AccessContext<'_>) -> S3Result<()> {
        let access_key = cx.credentials().map(|c| c.access_key.as_str());
        let action = map_operation_to_action(cx.s3_op().name());

        if self.evaluate(access_key, action, cx.s3_path()) {
            Ok(())
        } else {
            Err(s3s::s3_error!(AccessDenied))
        }
    }
}

/// Map S3 operation names to AWS-compatible Cedar action names.
fn map_operation_to_action(op_name: &str) -> &'static str {
    match op_name {
        "CreateBucket" => "s3:CreateBucket",
        "DeleteBucket" => "s3:DeleteBucket",
        "HeadBucket" => "s3:HeadBucket",
        "ListBuckets" => "s3:ListAllMyBuckets",
        "GetBucketLocation" => "s3:GetBucketLocation",
        "GetObject" => "s3:GetObject",
        "PutObject" => "s3:PutObject",
        "DeleteObject" | "DeleteObjects" => "s3:DeleteObject",
        "HeadObject" => "s3:HeadObject",
        "CopyObject" => "s3:CopyObject",
        "ListObjects" | "ListObjectsV2" => "s3:ListBucket",
        "CreateMultipartUpload" | "UploadPart" | "CompleteMultipartUpload" => "s3:PutObject",
        "AbortMultipartUpload" => "s3:AbortMultipartUpload",
        "ListParts" => "s3:ListMultipartUploadParts",
        "ListMultipartUploads" => "s3:ListBucketMultipartUploads",
        _ => "s3:Unknown",
    }
}

/// Create the principal entity UID for the given access key.
fn make_principal_uid(access_key: Option<&str>) -> EntityUid {
    let id = access_key.unwrap_or("anonymous");
    let type_name: EntityTypeName = "SmolS3::User".parse().expect("valid type name");
    let entity_id: EntityId = id.parse().expect("valid entity id");
    EntityUid::from_type_name_and_id(type_name, entity_id)
}

/// Create the action entity UID for the given action name.
fn make_action_uid(action: &str) -> EntityUid {
    let type_name: EntityTypeName = "SmolS3::Action".parse().expect("valid type name");
    let entity_id: EntityId = action.parse().expect("valid entity id");
    EntityUid::from_type_name_and_id(type_name, entity_id)
}

/// Create the resource entity UID based on the S3 path.
fn make_resource_uid(path: &S3Path) -> EntityUid {
    match path {
        S3Path::Root => {
            let type_name: EntityTypeName = "SmolS3::Service".parse().expect("valid type name");
            let entity_id: EntityId = "smols3".parse().expect("valid entity id");
            EntityUid::from_type_name_and_id(type_name, entity_id)
        }
        S3Path::Bucket { bucket } => {
            let type_name: EntityTypeName = "SmolS3::Bucket".parse().expect("valid type name");
            let entity_id: EntityId = bucket.parse().expect("valid entity id");
            EntityUid::from_type_name_and_id(type_name, entity_id)
        }
        S3Path::Object { bucket, key } => {
            let type_name: EntityTypeName = "SmolS3::Object".parse().expect("valid type name");
            let entity_id: EntityId = format!("{}/{}", bucket, key)
                .parse()
                .expect("valid entity id");
            EntityUid::from_type_name_and_id(type_name, entity_id)
        }
    }
}

/// Build the entity graph for Cedar evaluation.
///
/// Creates entities with proper hierarchy:
/// - Service (root)
/// - Bucket (parent: Service)
/// - Object (parent: Bucket, attributes: key, bucket)
/// - User (principal)
fn build_entities(principal: Option<&str>, path: &S3Path) -> Entities {
    let mut entities = vec![];

    // Service entity (root of hierarchy)
    let service_uid = {
        let type_name: EntityTypeName = "SmolS3::Service".parse().expect("valid type name");
        let entity_id: EntityId = "smols3".parse().expect("valid entity id");
        EntityUid::from_type_name_and_id(type_name, entity_id)
    };
    entities.push(
        Entity::new(service_uid.clone(), HashMap::new(), HashSet::new())
            .expect("entity construction"),
    );

    // Add principal entity
    let principal_uid = make_principal_uid(principal);
    entities.push(
        Entity::new(principal_uid, HashMap::new(), HashSet::new()).expect("entity construction"),
    );

    match path {
        S3Path::Root => {}
        S3Path::Bucket { bucket } => {
            let bucket_uid = {
                let type_name: EntityTypeName = "SmolS3::Bucket".parse().expect("valid type name");
                let entity_id: EntityId = bucket.parse().expect("valid entity id");
                EntityUid::from_type_name_and_id(type_name, entity_id)
            };
            entities.push(
                Entity::new(bucket_uid, HashMap::new(), HashSet::from([service_uid]))
                    .expect("entity construction"),
            );
        }
        S3Path::Object { bucket, key } => {
            let bucket_uid = {
                let type_name: EntityTypeName = "SmolS3::Bucket".parse().expect("valid type name");
                let entity_id: EntityId = bucket.parse().expect("valid entity id");
                EntityUid::from_type_name_and_id(type_name, entity_id)
            };
            entities.push(
                Entity::new(
                    bucket_uid.clone(),
                    HashMap::new(),
                    HashSet::from([service_uid]),
                )
                .expect("entity construction"),
            );

            let object_uid = {
                let type_name: EntityTypeName = "SmolS3::Object".parse().expect("valid type name");
                let entity_id: EntityId = format!("{}/{}", bucket, key)
                    .parse()
                    .expect("valid entity id");
                EntityUid::from_type_name_and_id(type_name, entity_id)
            };
            // Add key and bucket attributes for condition matching
            let attrs = HashMap::from([
                (
                    "key".into(),
                    RestrictedExpression::new_string(key.to_string()),
                ),
                (
                    "bucket".into(),
                    RestrictedExpression::new_string(bucket.to_string()),
                ),
            ]);
            entities.push(
                Entity::new(object_uid, attrs, HashSet::from([bucket_uid]))
                    .expect("entity construction"),
            );
        }
    }

    Entities::from_entities(entities, None).expect("entities construction")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_map_operation_to_action() {
        assert_eq!(map_operation_to_action("GetObject"), "s3:GetObject");
        assert_eq!(map_operation_to_action("PutObject"), "s3:PutObject");
        assert_eq!(map_operation_to_action("DeleteObject"), "s3:DeleteObject");
        assert_eq!(map_operation_to_action("DeleteObjects"), "s3:DeleteObject");
        assert_eq!(map_operation_to_action("ListObjects"), "s3:ListBucket");
        assert_eq!(map_operation_to_action("ListObjectsV2"), "s3:ListBucket");
        assert_eq!(map_operation_to_action("ListBuckets"), "s3:ListAllMyBuckets");
        assert_eq!(map_operation_to_action("CreateBucket"), "s3:CreateBucket");
        assert_eq!(map_operation_to_action("Unknown"), "s3:Unknown");
    }

    #[test]
    fn test_make_principal_uid() {
        let uid = make_principal_uid(Some("AKIAEXAMPLE"));
        assert_eq!(uid.to_string(), "SmolS3::User::\"AKIAEXAMPLE\"");

        let anon_uid = make_principal_uid(None);
        assert_eq!(anon_uid.to_string(), "SmolS3::User::\"anonymous\"");
    }

    #[test]
    fn test_make_action_uid() {
        let uid = make_action_uid("s3:GetObject");
        assert_eq!(uid.to_string(), "SmolS3::Action::\"s3:GetObject\"");
    }

    #[test]
    fn test_make_resource_uid() {
        let root_uid = make_resource_uid(&S3Path::Root);
        assert_eq!(root_uid.to_string(), "SmolS3::Service::\"smols3\"");

        let bucket_uid = make_resource_uid(&S3Path::Bucket {
            bucket: "test-bucket".into(),
        });
        assert_eq!(bucket_uid.to_string(), "SmolS3::Bucket::\"test-bucket\"");

        let object_uid = make_resource_uid(&S3Path::Object {
            bucket: "test-bucket".into(),
            key: "path/to/key".into(),
        });
        assert_eq!(
            object_uid.to_string(),
            "SmolS3::Object::\"test-bucket/path/to/key\""
        );
    }

    #[test]
    fn test_permit_all_policy() {
        let policy = r#"
            permit(principal, action, resource);
        "#;
        let authz = CedarAuthorizer::from_policy_str(policy).expect("valid policy");

        let path = S3Path::Bucket {
            bucket: "test".into(),
        };
        assert!(authz.evaluate(Some("anyuser"), "s3:GetObject", &path));
    }

    #[test]
    fn test_deny_by_default() {
        // Empty policy set - should deny everything
        let policy = "";
        let authz = CedarAuthorizer::from_policy_str(policy).expect("valid policy");

        let path = S3Path::Bucket {
            bucket: "test".into(),
        };
        assert!(!authz.evaluate(Some("anyuser"), "s3:GetObject", &path));
    }

    #[test]
    fn test_specific_user_permit() {
        let policy = r#"
            permit(
                principal == SmolS3::User::"AKIAADMIN",
                action,
                resource
            );
        "#;
        let authz = CedarAuthorizer::from_policy_str(policy).expect("valid policy");

        let path = S3Path::Bucket {
            bucket: "test".into(),
        };

        // Admin user should be allowed
        assert!(authz.evaluate(Some("AKIAADMIN"), "s3:GetObject", &path));

        // Other users should be denied
        assert!(!authz.evaluate(Some("AKIAOTHER"), "s3:GetObject", &path));
    }

    #[test]
    fn test_action_restriction() {
        let policy = r#"
            permit(
                principal,
                action == SmolS3::Action::"s3:GetObject",
                resource
            );
        "#;
        let authz = CedarAuthorizer::from_policy_str(policy).expect("valid policy");

        let path = S3Path::Object {
            bucket: "test".into(),
            key: "file.txt".into(),
        };

        // GetObject should be allowed
        assert!(authz.evaluate(Some("user"), "s3:GetObject", &path));

        // PutObject should be denied
        assert!(!authz.evaluate(Some("user"), "s3:PutObject", &path));
    }

    #[test]
    fn test_resource_hierarchy() {
        let policy = r#"
            permit(
                principal,
                action,
                resource in SmolS3::Bucket::"allowed-bucket"
            );
        "#;
        let authz = CedarAuthorizer::from_policy_str(policy).expect("valid policy");

        // Object in allowed bucket should be permitted
        let allowed_object = S3Path::Object {
            bucket: "allowed-bucket".into(),
            key: "file.txt".into(),
        };
        assert!(authz.evaluate(Some("user"), "s3:GetObject", &allowed_object));

        // The bucket itself should be permitted
        let allowed_bucket = S3Path::Bucket {
            bucket: "allowed-bucket".into(),
        };
        assert!(authz.evaluate(Some("user"), "s3:ListBucket", &allowed_bucket));

        // Object in different bucket should be denied
        let denied_object = S3Path::Object {
            bucket: "other-bucket".into(),
            key: "file.txt".into(),
        };
        assert!(!authz.evaluate(Some("user"), "s3:GetObject", &denied_object));
    }

    #[test]
    fn test_multiple_actions() {
        let policy = r#"
            permit(
                principal,
                action in [
                    SmolS3::Action::"s3:GetObject",
                    SmolS3::Action::"s3:HeadObject",
                    SmolS3::Action::"s3:ListBucket"
                ],
                resource
            );
        "#;
        let authz = CedarAuthorizer::from_policy_str(policy).expect("valid policy");

        let path = S3Path::Object {
            bucket: "test".into(),
            key: "file.txt".into(),
        };

        // Permitted actions
        assert!(authz.evaluate(Some("user"), "s3:GetObject", &path));
        assert!(authz.evaluate(Some("user"), "s3:HeadObject", &path));
        assert!(authz.evaluate(Some("user"), "s3:ListBucket", &path));

        // Denied actions
        assert!(!authz.evaluate(Some("user"), "s3:PutObject", &path));
        assert!(!authz.evaluate(Some("user"), "s3:DeleteObject", &path));
    }
}

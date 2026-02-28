// =============================================================================
// SAP Cloud Integration OData V2 Entity Type Interfaces
// Source: SAP Business Accelerator Hub — Cloud Integration API package
// =============================================================================

// -----------------------------------------------------------------------------
// Integration Content API
// -----------------------------------------------------------------------------

/**
 * Integration package containing one or more integration artifacts.
 * OData path: /IntegrationPackages
 */
export interface IntegrationPackage {
  /** Technical identifier of the integration package */
  Id: string;
  /** Display name */
  Name: string;
  /** Long description */
  Description?: string;
  /** Short description / subtitle */
  ShortText?: string;
  /** Semantic version string (e.g. "1.0.0") */
  Version?: string;
  /** Vendor / publisher */
  Vendor?: string;
  /** Editing mode */
  Mode?: "EDIT_ALLOWED" | "READ_ONLY";
  /** Target runtime platform */
  SupportedPlatform?: string;
  /** User who last modified the package */
  ModifiedBy?: string;
  /** Epoch timestamp (as string in OData V2) of last modification */
  ModifiedDate?: string;
  /** User who created the package */
  CreatedBy?: string;
  /** Epoch timestamp (as string in OData V2) of creation */
  CreatedDate?: string;
  /** Comma-separated product identifiers */
  Products?: string;
}

/**
 * Design-time representation of an integration flow artifact.
 * OData path: /IntegrationDesigntimeArtifacts
 */
export interface IntegrationDesigntimeArtifact {
  /** Technical identifier of the artifact */
  Id: string;
  /** Semantic version string */
  Version: string;
  /** Identifier of the containing package */
  PackageId: string;
  /** Display name */
  Name: string;
  /** Description of the artifact */
  Description?: string;
  /** Base64-encoded binary content of the artifact archive */
  ArtifactContent?: string;
}

/**
 * Runtime representation of a deployed integration flow.
 * OData path: /IntegrationRuntimeArtifacts
 */
export interface IntegrationRuntimeArtifact {
  /** Technical identifier */
  Id: string;
  /** Deployed version */
  Version: string;
  /** Display name */
  Name: string;
  /** Artifact type */
  Type?: string;
  /** User who deployed the artifact */
  DeployedBy?: string;
  /** Epoch timestamp of deployment */
  DeployedOn?: string;
  /** Current runtime status */
  Status?: "STARTED" | "STOPPING" | "ERROR" | "STARTING";
}

/**
 * Externalized configuration parameter of an integration artifact.
 * OData path: /IntegrationDesigntimeArtifacts('{Id}','{Version}')/$links/Configurations
 */
export interface Configuration {
  /** Name of the configuration parameter */
  ParameterKey: string;
  /** Value of the configuration parameter */
  ParameterValue: string;
  /** Data type of the parameter (e.g. xsd:string, xsd:integer) */
  DataType?: string;
}

/**
 * A resource (e.g. XSLT, XSD, WSDL) belonging to an artifact.
 * OData path: /IntegrationDesigntimeArtifacts('{Id}','{Version}')/$links/Resources
 */
export interface Resource {
  /** Resource file name */
  Name: string;
  /** Type of the resource (e.g. xslt, xsd, wsdl, jar, edmx) */
  ResourceType?: string;
  /** Type that this resource references */
  ReferencedResourceType?: string;
  /** Base64-encoded binary content of the resource */
  ResourceContent?: string;
}

/**
 * Design-time value mapping artifact.
 * OData path: /ValueMappingDesigntimeArtifacts
 */
export interface ValueMappingDesigntimeArtifact {
  /** Technical identifier */
  Id: string;
  /** Semantic version string */
  Version: string;
  /** Identifier of the containing package */
  PackageId: string;
  /** Display name */
  Name: string;
  /** Description */
  Description?: string;
}

/**
 * Schema entry within a value mapping (source/target agency + identifier pair).
 * OData path: /ValueMappingDesigntimeArtifacts('{Id}','{Version}')/ValMapSchema
 */
export interface ValMapSchema {
  /** Source agency identifier */
  SrcAgency: string;
  /** Source schema identifier */
  SrcId: string;
  /** Target agency identifier */
  TgtAgency: string;
  /** Target schema identifier */
  TgtId: string;
  /** Schema state */
  State?: string;
}

/**
 * Design-time message mapping artifact.
 * OData path: /MessageMappingDesigntimeArtifacts
 */
export interface MessageMappingDesigntimeArtifact {
  /** Technical identifier */
  Id: string;
  /** Semantic version string */
  Version: string;
  /** Identifier of the containing package */
  PackageId: string;
  /** Display name */
  Name: string;
  /** Description */
  Description?: string;
}

/**
 * Design-time script collection artifact.
 * OData path: /ScriptCollectionDesigntimeArtifacts
 */
export interface ScriptCollectionDesigntimeArtifact {
  /** Technical identifier */
  Id: string;
  /** Semantic version string */
  Version: string;
  /** Identifier of the containing package */
  PackageId: string;
  /** Display name */
  Name: string;
  /** Description */
  Description?: string;
}

/**
 * Custom tag configuration for tagging integration content artifacts.
 * OData path: /CustomTagConfigurations
 */
export interface CustomTagConfiguration {
  /** Technical identifier */
  Id: string;
  /** Name of the custom tag */
  TagName: string;
  /** Comma-separated list of allowed values for this tag */
  TagValues?: string;
  /** Whether this tag can be applied to integration flows */
  AllowedForIFlow?: boolean;
  /** Whether this tag can be applied to value mappings */
  AllowedForValueMapping?: boolean;
  /** Whether this tag can be applied to message mappings */
  AllowedForMapping?: boolean;
  /** Whether this tag can be applied to script collections */
  AllowedForScript?: boolean;
}

/**
 * Status of an asynchronous build-and-deploy task.
 * OData path: /BuildAndDeployStatus('{TaskId}')
 */
export interface BuildAndDeployStatus {
  /** Identifier of the background task */
  TaskId: string;
  /** Current status of the task */
  Status: string;
  /** Status / error messages */
  Messages?: string;
}

// -----------------------------------------------------------------------------
// Message Processing Logs API
// -----------------------------------------------------------------------------

/**
 * Processing log entry for a single message execution.
 * OData path: /MessageProcessingLogs
 */
export interface MessageProcessingLog {
  /** Unique message GUID */
  MessageGuid: string;
  /** Correlation identifier linking related messages */
  CorrelationId?: string;
  /** Application-level message identifier */
  ApplicationMessageId?: string;
  /** Application-level message type */
  ApplicationMessageType?: string;
  /** Timestamp when log recording started */
  LogStart?: string;
  /** Timestamp when log recording ended */
  LogEnd?: string;
  /** Sending party */
  Sender?: string;
  /** Receiving party */
  Receiver?: string;
  /** Name of the integration flow that processed the message */
  IntegrationFlowName?: string;
  /** Overall processing status */
  Status?: "COMPLETED" | "PROCESSING" | "RETRY" | "FAILED" | "ESCALATED" | "ABANDONED" | "DISCARDED";
  /** Log verbosity level */
  LogLevel?: string;
  /** Custom status string set by the integration flow */
  CustomStatus?: string;
  /** Transaction identifier */
  TransactionId?: string;
  /** Name of the previous processing component */
  PreviousComponentName?: string;
  /** Name of the local processing component */
  LocalComponentName?: string;
  /** Alternate web address for the processing log */
  AlternateWebAddress?: string;
}

/**
 * Attachment (payload / header snapshot) linked to a message processing log.
 * OData path: /MessageProcessingLogs('{MessageGuid}')/Attachments
 */
export interface MessageProcessingLogAttachment {
  /** Unique attachment identifier */
  Id: string;
  /** Attachment file name */
  Name?: string;
  /** MIME content type */
  ContentType?: string;
  /** Size of the payload in bytes */
  PayloadSize?: number;
}

/**
 * Error details for a failed message processing log entry.
 * OData path: /MessageProcessingLogs('{MessageGuid}')/ErrorInformation
 */
export interface ErrorInformation {
  /** GUID of the related message processing log */
  MessageGuid: string;
  /** Error category classification */
  ErrorCategory?: string;
  /** Human-readable error text / stack trace */
  ErrorText?: string;
}

/**
 * Adapter-specific attribute recorded during message processing.
 * OData path: /MessageProcessingLogs('{MessageGuid}')/AdapterAttributes
 */
export interface AdapterAttribute {
  /** Unique identifier */
  Id: string;
  /** Attribute name */
  Name?: string;
  /** Attribute value */
  Value?: string;
}

/**
 * Custom header property recorded during message processing.
 * OData path: /MessageProcessingLogs('{MessageGuid}')/CustomHeaderProperties
 */
export interface CustomHeaderProperty {
  /** Unique identifier */
  Id: string;
  /** Header property name */
  Name?: string;
  /** Header property value */
  Value?: string;
}

/**
 * ID mapping entry (maps between two identifiers in a given context).
 * OData path: /IdMapFromId2s
 */
export interface IdMapFromId2 {
  /** Unique identifier of the mapping entry */
  Id: string;
  /** First mapped identifier */
  Id1?: string;
  /** Second mapped identifier */
  Id2?: string;
  /** Mapping context */
  Context?: string;
  /** Partner identifier */
  Pid?: string;
}

/**
 * Idempotent repository entry for exactly-once processing.
 * OData path: /IdempotentRepositoryEntries
 */
export interface IdempotentRepositoryEntry {
  /** Source system / adapter */
  Source: string;
  /** Entry value (message ID or similar) */
  Entry: string;
  /** Component that created the entry */
  Component: string;
}

// -----------------------------------------------------------------------------
// Message Stores API
// -----------------------------------------------------------------------------

/**
 * Entry in a JMS message store (persisted messages).
 * OData path: /MessageStoreEntries
 */
export interface MessageStoreEntry {
  /** Unique identifier of the store entry */
  Id: string;
  /** Associated message GUID */
  MessageGuid?: string;
  /** Application-level message identifier */
  MessageId?: string;
  /** Name of the integration flow */
  FlowName?: string;
  /** Timestamp of the entry */
  Date?: string;
  /** Processing status */
  Status?: string;
  /** Sending party */
  Sender?: string;
  /** Receiving party */
  Receiver?: string;
}

/**
 * Entry in a data store (key-value persistence for integration flows).
 * OData path: /DataStoreEntries
 */
export interface DataStoreEntry {
  /** Unique entry identifier (within the data store) */
  Id: string;
  /** Name of the data store */
  DataStoreName: string;
  /** Name of the integration flow that owns this data store */
  IntegrationFlow: string;
  /** Entry type (e.g. "default") */
  Type?: string;
  /** Entry status */
  Status?: string;
  /** Application-level message identifier */
  MessageId?: string;
  /** Due-at timestamp (for scheduled retries) */
  DueAt?: string;
  /** Creation timestamp */
  CreatedAt?: string;
  /** Timestamp until which the entry is retained */
  RetainUntil?: string;
}

/**
 * Global or integration-flow-scoped variable.
 * OData path: /Variables
 */
export interface Variable {
  /** Name of the variable */
  VariableName: string;
  /** Name of the owning integration flow */
  IntegrationFlow: string;
  /** Visibility scope */
  Visibility?: "Global" | "Integration Flow";
  /** Current variable value */
  Value?: string;
  /** Timestamp until which the variable is retained */
  RetainUntil?: string;
  /** Last-updated timestamp */
  UpdatedAt?: string;
}

/**
 * Number range configuration (auto-incrementing counters).
 * OData path: /NumberRanges
 */
export interface NumberRange {
  /** Name of the number range */
  Name: string;
  /** Minimum value in the range */
  MinValue: string;
  /** Maximum value in the range */
  MaxValue: string;
  /** Whether the range rotates (wraps around) after reaching MaxValue */
  Rotate?: boolean;
  /** Current counter value */
  CurrentValue?: string;
  /** Length of the generated number field */
  FieldLength?: number;
}

/**
 * JMS broker instance information.
 * OData path: /JmsBrokers
 */
export interface JmsBroker {
  /** Broker key */
  Key: string;
  /** Type of the broker */
  BrokerType?: string;
  /** Current number of queues */
  QueueNumber?: number;
  /** Maximum number of queues allowed */
  MaxQueueNumber?: number;
  /** High-water mark for transacted sessions */
  TransactedSessionsHigh?: number;
  /** Broker capacity */
  Capacity?: number;
  /** Whether the transacted sessions limit is exhausted */
  IsTransactedSessionsExhausted?: boolean;
}

/**
 * JMS queue / topic resource.
 * OData path: /JmsResources
 */
export interface JmsResource {
  /** Queue or topic name */
  Name: string;
  /** Resource type (Queue / Topic) */
  Type?: string;
  /** Current queue size in megabytes */
  QueueSizeMB?: number;
  /** Maximum queue size in megabytes */
  MaxQueueSizeMB?: number;
  /** Number of messages currently in the queue */
  MessagesinQueue?: number;
  /** Whether the capacity limit has been reached */
  IsCapacityReached?: boolean;
}

// -----------------------------------------------------------------------------
// Log Files API
// -----------------------------------------------------------------------------

/**
 * Log file available for download from a runtime node.
 * OData path: /LogFiles
 */
export interface LogFile {
  /** Log file name */
  Name: string;
  /** Application that produced the log */
  Application?: string;
  /** Last-modified timestamp */
  LastModified?: string;
  /** MIME content type of the log file */
  ContentType?: string;
  /** Size of the log file in bytes */
  LogFileSize?: number;
  /** Log scope */
  Scope?: string;
  /** Node-level scope */
  NodeScope?: string;
  /** Identifier of the runtime node */
  NodeId?: string;
}

/**
 * Archived log file bundle.
 * OData path: /LogFileArchives
 */
export interface LogFileArchive {
  /** Archive file name */
  Name: string;
  /** Application that produced the log */
  Application?: string;
  /** Last-modified timestamp */
  LastModified?: string;
  /** MIME content type */
  ContentType?: string;
  /** Size of the log file in bytes */
  LogFileSize?: number;
  /** Log scope */
  Scope?: string;
  /** Node-level scope */
  NodeScope?: string;
  /** Name of the enclosing archive */
  ArchiveName?: string;
}

// -----------------------------------------------------------------------------
// Partner Directory API
// -----------------------------------------------------------------------------

/**
 * Partner entry in the Partner Directory.
 * OData path: /Partners
 */
export interface Partner {
  /** Partner identifier */
  Pid: string;
  /** User who last modified the partner */
  LastModifiedBy?: string;
  /** Last-modified timestamp */
  LastModifiedAt?: string;
  /** User who created the partner */
  CreatedBy?: string;
  /** Creation timestamp */
  CreatedAt?: string;
}

/**
 * String parameter associated with a partner.
 * OData path: /StringParameters
 */
export interface StringParameter {
  /** Partner identifier */
  Pid: string;
  /** Parameter identifier */
  Id: string;
  /** Parameter value */
  Value?: string;
  /** User who last modified the parameter */
  LastModifiedBy?: string;
  /** Last-modified timestamp */
  LastModifiedAt?: string;
  /** User who created the parameter */
  CreatedBy?: string;
  /** Creation timestamp */
  CreatedAt?: string;
}

/**
 * Binary parameter associated with a partner.
 * OData path: /BinaryParameters
 */
export interface BinaryParameter {
  /** Partner identifier */
  Pid: string;
  /** Parameter identifier */
  Id: string;
  /** MIME content type of the binary value */
  ContentType?: string;
  /** Base64-encoded binary value */
  Value?: string;
  /** User who last modified the parameter */
  LastModifiedBy?: string;
  /** Last-modified timestamp */
  LastModifiedAt?: string;
  /** User who created the parameter */
  CreatedBy?: string;
  /** Creation timestamp */
  CreatedAt?: string;
}

/**
 * Alternative partner identification (agency + scheme mapping).
 * OData path: /AlternativePartners
 */
export interface AlternativePartner {
  /** Partner identifier */
  Pid: string;
  /** Alternative partner identifier */
  Id: string;
  /** Issuing agency */
  Agency: string;
  /** Identification scheme */
  Scheme: string;
  /** User who last modified the entry */
  LastModifiedBy?: string;
  /** Last-modified timestamp */
  LastModifiedAt?: string;
  /** User who created the entry */
  CreatedBy?: string;
  /** Creation timestamp */
  CreatedAt?: string;
}

/**
 * Authorized user associated with a partner.
 * OData path: /AuthorizedUsers
 */
export interface AuthorizedUser {
  /** Partner identifier */
  Pid: string;
  /** Entry identifier */
  Id: string;
  /** Authorized user name */
  User: string;
  /** User who last modified the entry */
  LastModifiedBy?: string;
  /** Last-modified timestamp */
  LastModifiedAt?: string;
  /** User who created the entry */
  CreatedBy?: string;
  /** Creation timestamp */
  CreatedAt?: string;
}

// -----------------------------------------------------------------------------
// Security Content API
// -----------------------------------------------------------------------------

/**
 * Entry in the tenant keystore (certificate, key pair, etc.).
 * OData path: /KeystoreEntries
 */
export interface KeystoreEntry {
  /** Hex-encoded alias (URL-safe key) */
  Hexalias: string;
  /** Human-readable alias */
  Alias: string;
  /** Entry type */
  Type?: "RSAKeyPair" | "Certificate" | "Key Pair" | "SSH Key Pair";
  /** Key size in bits */
  KeySize?: number;
  /** Signature algorithm (e.g. SHA256withRSA) */
  SignatureAlgorithm?: string;
  /** Certificate fingerprint */
  Fingerprint?: string;
  /** Certificate serial number */
  SerialNumber?: string;
  /** Certificate validity start */
  ValidNotBefore?: string;
  /** Certificate validity end */
  ValidNotAfter?: string;
  /** Subject distinguished name */
  SubjectDN?: string;
  /** Issuer distinguished name */
  IssuerDN?: string;
  /** Owner of the keystore entry */
  Owner?: string;
  /** User who last modified the entry */
  LastModifiedBy?: string;
  /** Last-modified timestamp */
  LastModifiedAt?: string;
  /** User who created the entry */
  CreatedBy?: string;
  /** Creation timestamp */
  CreatedAt?: string;
}

/**
 * Certificate resource in the keystore (read-only view).
 * OData path: /CertificateResources
 */
export interface CertificateResource {
  /** Hex-encoded alias */
  Hexalias: string;
  /** Human-readable alias */
  Alias: string;
  /** Certificate type */
  Type?: string;
  /** Certificate serial number */
  SerialNumber?: string;
  /** Certificate validity start */
  ValidNotBefore?: string;
  /** Certificate validity end */
  ValidNotAfter?: string;
  /** Subject distinguished name */
  SubjectDN?: string;
  /** Issuer distinguished name */
  IssuerDN?: string;
  /** Signature algorithm */
  SignatureAlgorithm?: string;
  /** Certificate version */
  Version?: string;
}

/**
 * SSH key resource in the keystore.
 * OData path: /SSHKeyResources
 */
export interface SSHKeyResource {
  /** Hex-encoded alias */
  Hexalias: string;
  /** Human-readable alias */
  Alias: string;
  /** Key size in bits */
  KeySize?: number;
  /** Key type (e.g. RSA, DSA, ED25519) */
  Type?: string;
  /** Key comment */
  Comment?: string;
  /** Key fingerprint */
  Fingerprint?: string;
}

/**
 * Deployed user credential (basic auth) security artifact.
 * OData path: /UserCredentials
 */
export interface UserCredential {
  /** Credential name (unique identifier) */
  Name: string;
  /** Credential kind */
  Kind?: "default" | "successfactors" | "openconnectors";
  /** Description */
  Description?: string;
  /** User / username */
  User?: string;
  /** Password (write-only; not returned on read) */
  Password?: string;
  /** Company ID (for SuccessFactors credentials) */
  CompanyId?: string;
  /** Security artifact descriptor reference */
  SecurityArtifactDescriptor?: string;
  /** User who deployed the credential */
  DeployedBy?: string;
  /** Deployment timestamp */
  DeployedOn?: string;
  /** Deployment status */
  Status?: string;
}

/**
 * Deployed OAuth 2.0 client credentials security artifact.
 * OData path: /OAuth2ClientCredentials
 */
export interface OAuth2ClientCredential {
  /** Credential name (unique identifier) */
  Name: string;
  /** Description */
  Description?: string;
  /** Token service URL */
  TokenServiceUrl?: string;
  /** OAuth client ID */
  ClientId?: string;
  /** OAuth client secret (write-only; not returned on read) */
  ClientSecret?: string;
  /** Client authentication method */
  ClientAuthentication?: string;
  /** OAuth scope */
  Scope?: string;
  /** Content type of the scope parameter */
  ScopeContentType?: string;
  /** User who deployed the credential */
  DeployedBy?: string;
  /** Deployment timestamp */
  DeployedOn?: string;
  /** Deployment status */
  Status?: string;
}

/**
 * Deployed secure parameter (encrypted key-value pair).
 * OData path: /SecureParameters
 */
export interface SecureParameter {
  /** Parameter name (unique identifier) */
  Name: string;
  /** Description */
  Description?: string;
  /** Secure parameter value (write-only; not returned on read) */
  SecureParam?: string;
  /** User who deployed the parameter */
  DeployedBy?: string;
  /** Deployment timestamp */
  DeployedOn?: string;
  /** Deployment status */
  Status?: string;
}

/**
 * Certificate-to-user mapping for inbound client-certificate authentication.
 * OData path: /CertificateUserMappings
 */
export interface CertificateUserMapping {
  /** Mapping identifier */
  Id: string;
  /** Mapped user name */
  User?: string;
  /** Certificate (subject DN or serial) used for matching */
  Certificate?: string;
  /** User who last modified the mapping */
  LastModifiedBy?: string;
  /** Last-modified timestamp */
  LastModifiedAt?: string;
}

/**
 * Access policy controlling which users may access specific artifacts.
 * OData path: /AccessPolicies
 */
export interface AccessPolicy {
  /** Access policy identifier */
  Id: string;
  /** Description of the policy */
  Description?: string;
  /** User who last modified the policy */
  LastModifiedBy?: string;
  /** Last-modified timestamp */
  LastModifiedAt?: string;
}

/**
 * Reference to an artifact within an access policy.
 * OData path: /AccessPolicies('{Id}')/ArtifactReferences
 */
export interface ArtifactReference {
  /** Reference identifier */
  Id: string;
  /** Artifact name */
  Name?: string;
  /** Artifact type */
  Type?: string;
  /** Condition attribute for matching */
  ConditionAttribute?: string;
  /** Condition value for matching */
  ConditionValue?: string;
}

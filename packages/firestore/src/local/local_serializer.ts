/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Timestamp } from '../api/timestamp';
import { BundleMetadata, NamedQuery } from '../core/bundle';
import { LimitType, Query, queryWithLimit } from '../core/query';
import { SnapshotVersion } from '../core/snapshot_version';
import { canonifyTarget, targetIsDocumentTarget, Target } from '../core/target';
import { MutableDocument } from '../model/document';
import { DocumentKey } from '../model/document_key';
import { MutationBatch } from '../model/mutation_batch';
import {
  BundleMetadata as ProtoBundleMetadata,
  NamedQuery as ProtoNamedQuery,
  BundledQuery as ProtoBundledQuery
} from '../protos/firestore_bundle_proto';
import { DocumentsTarget as PublicDocumentsTarget } from '../protos/firestore_proto_api';
import {
  convertQueryTargetToQuery,
  fromDocument,
  fromDocumentsTarget,
  fromMutation,
  fromQueryTarget,
  fromVersion,
  JsonProtoSerializer,
  toDocument,
  toDocumentsTarget,
  toMutation,
  toQueryTarget
} from '../remote/serializer';
import { debugAssert, fail } from '../util/assert';
import { ByteString } from '../util/byte_string';

import {
  DbBundle,
  DbMutationBatch,
  DbNamedQuery,
  DbNoDocument,
  DbQuery,
  DbRemoteDocument,
  DbTarget,
  DbTimestamp,
  DbTimestampKey,
  DbUnknownDocument
} from './indexeddb_schema';
import { TargetData, TargetPurpose } from './target_data';

/** Serializer for values stored in the LocalStore. */
export class LocalSerializer {
  constructor(readonly remoteSerializer: JsonProtoSerializer) {}
}

/** Decodes a remote document from storage locally to a Document. */
export function fromDbRemoteDocument(
  localSerializer: LocalSerializer,
  remoteDoc: DbRemoteDocument
): MutableDocument {
  let doc: MutableDocument;
  if (remoteDoc.document) {
    doc = fromDocument(
      localSerializer.remoteSerializer,
      remoteDoc.document,
      !!remoteDoc.hasCommittedMutations
    );
  } else if (remoteDoc.noDocument) {
    const key = DocumentKey.fromSegments(remoteDoc.noDocument.path);
    const version = fromDbTimestamp(remoteDoc.noDocument.readTime);
    doc = MutableDocument.newNoDocument(key, version);
    if (remoteDoc.hasCommittedMutations) {
      doc.setHasCommittedMutations();
    }
  } else if (remoteDoc.unknownDocument) {
    const key = DocumentKey.fromSegments(remoteDoc.unknownDocument.path);
    const version = fromDbTimestamp(remoteDoc.unknownDocument.version);
    doc = MutableDocument.newUnknownDocument(key, version);
  } else {
    return fail('Unexpected DbRemoteDocument');
  }

  if (remoteDoc.readTime) {
    doc.setReadTime(fromDbTimestampKey(remoteDoc.readTime));
  }

  return doc;
}

/** Encodes a document for storage locally. */
export function toDbRemoteDocument(
  localSerializer: LocalSerializer,
  document: MutableDocument
): DbRemoteDocument {
  const dbReadTime = toDbTimestampKey(document.readTime);
  const parentPath = document.key.path.popLast().toArray();
  if (document.isFoundDocument()) {
    const doc = toDocument(localSerializer.remoteSerializer, document);
    const hasCommittedMutations = document.hasCommittedMutations;
    return new DbRemoteDocument(
      /* unknownDocument= */ null,
      /* noDocument= */ null,
      doc,
      hasCommittedMutations,
      dbReadTime,
      parentPath
    );
  } else if (document.isNoDocument()) {
    const path = document.key.path.toArray();
    const version = toDbTimestamp(document.version);
    const hasCommittedMutations = document.hasCommittedMutations;
    return new DbRemoteDocument(
      /* unknownDocument= */ null,
      new DbNoDocument(path, version),
      /* document= */ null,
      hasCommittedMutations,
      dbReadTime,
      parentPath
    );
  } else if (document.isUnknownDocument()) {
    const path = document.key.path.toArray();
    const readTime = toDbTimestamp(document.version);
    return new DbRemoteDocument(
      new DbUnknownDocument(path, readTime),
      /* noDocument= */ null,
      /* document= */ null,
      /* hasCommittedMutations= */ true,
      dbReadTime,
      parentPath
    );
  } else {
    return fail('Unexpected Document ' + document);
  }
}

export function toDbTimestampKey(
  snapshotVersion: SnapshotVersion
): DbTimestampKey {
  const timestamp = snapshotVersion.toTimestamp();
  return [timestamp.seconds, timestamp.nanoseconds];
}

export function fromDbTimestampKey(
  dbTimestampKey: DbTimestampKey
): SnapshotVersion {
  const timestamp = new Timestamp(dbTimestampKey[0], dbTimestampKey[1]);
  return SnapshotVersion.fromTimestamp(timestamp);
}

function toDbTimestamp(snapshotVersion: SnapshotVersion): DbTimestamp {
  const timestamp = snapshotVersion.toTimestamp();
  return new DbTimestamp(timestamp.seconds, timestamp.nanoseconds);
}

function fromDbTimestamp(dbTimestamp: DbTimestamp): SnapshotVersion {
  const timestamp = new Timestamp(dbTimestamp.seconds, dbTimestamp.nanoseconds);
  return SnapshotVersion.fromTimestamp(timestamp);
}

/** Encodes a batch of mutations into a DbMutationBatch for local storage. */
export function toDbMutationBatch(
  localSerializer: LocalSerializer,
  userId: string,
  batch: MutationBatch
): DbMutationBatch {
  const serializedBaseMutations = batch.baseMutations.map(m =>
    toMutation(localSerializer.remoteSerializer, m)
  );
  const serializedMutations = batch.mutations.map(m =>
    toMutation(localSerializer.remoteSerializer, m)
  );
  return new DbMutationBatch(
    userId,
    batch.batchId,
    batch.localWriteTime.toMillis(),
    serializedBaseMutations,
    serializedMutations
  );
}

/** Decodes a DbMutationBatch into a MutationBatch */
export function fromDbMutationBatch(
  localSerializer: LocalSerializer,
  dbBatch: DbMutationBatch
): MutationBatch {
  const baseMutations = (dbBatch.baseMutations || []).map(m =>
    fromMutation(localSerializer.remoteSerializer, m)
  );

  // Squash old transform mutations into existing patch or set mutations.
  // The replacement of representing `transforms` with `update_transforms`
  // on the SDK means that old `transform` mutations stored in IndexedDB need
  // to be updated to `update_transforms`.
  // TODO(b/174608374): Remove this code once we perform a schema migration.
  for (let i = 0; i < dbBatch.mutations.length - 1; ++i) {
    const currentMutation = dbBatch.mutations[i];
    const hasTransform =
      i + 1 < dbBatch.mutations.length &&
      dbBatch.mutations[i + 1].transform !== undefined;
    if (hasTransform) {
      debugAssert(
        dbBatch.mutations[i].transform === undefined &&
          dbBatch.mutations[i].update !== undefined,
        'TransformMutation should be preceded by a patch or set mutation'
      );
      const transformMutation = dbBatch.mutations[i + 1];
      currentMutation.updateTransforms =
        transformMutation.transform!.fieldTransforms;
      dbBatch.mutations.splice(i + 1, 1);
      ++i;
    }
  }

  const mutations = dbBatch.mutations.map(m =>
    fromMutation(localSerializer.remoteSerializer, m)
  );
  const timestamp = Timestamp.fromMillis(dbBatch.localWriteTimeMs);
  return new MutationBatch(
    dbBatch.batchId,
    timestamp,
    baseMutations,
    mutations
  );
}

/** Decodes a DbTarget into TargetData */
export function fromDbTarget(dbTarget: DbTarget): TargetData {
  const version = fromDbTimestamp(dbTarget.readTime);
  const lastLimboFreeSnapshotVersion =
    dbTarget.lastLimboFreeSnapshotVersion !== undefined
      ? fromDbTimestamp(dbTarget.lastLimboFreeSnapshotVersion)
      : SnapshotVersion.min();

  let target: Target;
  if (isDocumentQuery(dbTarget.query)) {
    target = fromDocumentsTarget(dbTarget.query);
  } else {
    target = fromQueryTarget(dbTarget.query);
  }
  return new TargetData(
    target,
    dbTarget.targetId,
    TargetPurpose.Listen,
    dbTarget.lastListenSequenceNumber,
    version,
    lastLimboFreeSnapshotVersion,
    ByteString.fromBase64String(dbTarget.resumeToken)
  );
}

/** Encodes TargetData into a DbTarget for storage locally. */
export function toDbTarget(
  localSerializer: LocalSerializer,
  targetData: TargetData
): DbTarget {
  debugAssert(
    TargetPurpose.Listen === targetData.purpose,
    'Only queries with purpose ' +
      TargetPurpose.Listen +
      ' may be stored, got ' +
      targetData.purpose
  );
  const dbTimestamp = toDbTimestamp(targetData.snapshotVersion);
  const dbLastLimboFreeTimestamp = toDbTimestamp(
    targetData.lastLimboFreeSnapshotVersion
  );
  let queryProto: DbQuery;
  if (targetIsDocumentTarget(targetData.target)) {
    queryProto = toDocumentsTarget(
      localSerializer.remoteSerializer,
      targetData.target
    );
  } else {
    queryProto = toQueryTarget(
      localSerializer.remoteSerializer,
      targetData.target
    );
  }

  // We can't store the resumeToken as a ByteString in IndexedDb, so we
  // convert it to a base64 string for storage.
  const resumeToken = targetData.resumeToken.toBase64();

  // lastListenSequenceNumber is always 0 until we do real GC.
  return new DbTarget(
    targetData.targetId,
    canonifyTarget(targetData.target),
    dbTimestamp,
    resumeToken,
    targetData.sequenceNumber,
    dbLastLimboFreeTimestamp,
    queryProto
  );
}

/**
 * A helper function for figuring out what kind of query has been stored.
 */
function isDocumentQuery(dbQuery: DbQuery): dbQuery is PublicDocumentsTarget {
  return (dbQuery as PublicDocumentsTarget).documents !== undefined;
}

/** Encodes a DbBundle to a BundleMetadata object. */
export function fromDbBundle(dbBundle: DbBundle): BundleMetadata {
  return {
    id: dbBundle.bundleId,
    createTime: fromDbTimestamp(dbBundle.createTime),
    version: dbBundle.version
  };
}

/** Encodes a BundleMetadata to a DbBundle. */
export function toDbBundle(metadata: ProtoBundleMetadata): DbBundle {
  return {
    bundleId: metadata.id!,
    createTime: toDbTimestamp(fromVersion(metadata.createTime!)),
    version: metadata.version!
  };
}

/** Encodes a DbNamedQuery to a NamedQuery. */
export function fromDbNamedQuery(dbNamedQuery: DbNamedQuery): NamedQuery {
  return {
    name: dbNamedQuery.name,
    query: fromBundledQuery(dbNamedQuery.bundledQuery),
    readTime: fromDbTimestamp(dbNamedQuery.readTime)
  };
}

/** Encodes a NamedQuery from a bundle proto to a DbNamedQuery. */
export function toDbNamedQuery(query: ProtoNamedQuery): DbNamedQuery {
  return {
    name: query.name!,
    readTime: toDbTimestamp(fromVersion(query.readTime!)),
    bundledQuery: query.bundledQuery!
  };
}

/**
 * Encodes a `BundledQuery` from bundle proto to a Query object.
 *
 * This reconstructs the original query used to build the bundle being loaded,
 * including features exists only in SDKs (for example: limit-to-last).
 */
export function fromBundledQuery(bundledQuery: ProtoBundledQuery): Query {
  const query = convertQueryTargetToQuery({
    parent: bundledQuery.parent!,
    structuredQuery: bundledQuery.structuredQuery!
  });
  if (bundledQuery.limitType === 'LAST') {
    debugAssert(
      !!query.limit,
      'Bundled query has limitType LAST, but limit is null'
    );
    return queryWithLimit(query, query.limit, LimitType.Last);
  }
  return query;
}

/** Encodes a NamedQuery proto object to a NamedQuery model object. */
export function fromProtoNamedQuery(namedQuery: ProtoNamedQuery): NamedQuery {
  return {
    name: namedQuery.name!,
    query: fromBundledQuery(namedQuery.bundledQuery!),
    readTime: fromVersion(namedQuery.readTime!)
  };
}

/** Decodes a BundleMetadata proto into a BundleMetadata object. */
export function fromBundleMetadata(
  metadata: ProtoBundleMetadata
): BundleMetadata {
  return {
    id: metadata.id!,
    version: metadata.version!,
    createTime: fromVersion(metadata.createTime!)
  };
}

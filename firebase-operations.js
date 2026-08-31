import { db, auth } from './firebase.js';
import { getPlanConfig } from './plan-config.js';
import {
  doc,
  collection,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  getDoc,
  getDocFromServer,
  getDocs,
  writeBatch,
  increment,
  Timestamp,
  serverTimestamp 
} from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';

// --- Profile Operations ---

/**
 * Get a signed Cloudinary upload signature from the backend.
 * This replaces the unsigned preset — only authenticated users can upload.
 */
async function getCloudinarySignature(resourceType = 'image') {
  const user = auth.currentUser;
  if (!user) throw new Error('Must be signed in to upload files.');
  const idToken = await user.getIdToken();
  const { getBackendBaseUrl } = await import('./config.js');
  const res = await fetch(`${getBackendBaseUrl()}/api/cloudinary/sign`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ resourceType })
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.message || 'Failed to get upload signature');
  return data; // { signature, timestamp, apiKey, cloudName, folder }
}

function getCloudinaryResourceType(file) {
  if (!file?.type) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'video';
  return 'image';
}

/**
 * Upload a file to Cloudinary using a server-signed request.
 * Replaces the old unsigned preset approach.
 */
async function cloudinaryUpload(file, resourceType = null) {
  const resolvedResourceType = resourceType || getCloudinaryResourceType(file);
  const { signature, timestamp, apiKey, cloudName, folder } = await getCloudinarySignature(resolvedResourceType);
  const url = `https://api.cloudinary.com/v1_1/${cloudName}/${resolvedResourceType}/upload`;
  const formData = new FormData();
  formData.append('file', file);
  formData.append('api_key', apiKey);
  formData.append('timestamp', timestamp);
  formData.append('signature', signature);
  formData.append('folder', folder);
  formData.append('resource_type', resolvedResourceType);
  const response = await fetch(url, { method: 'POST', body: formData });
  const data = await response.json();
  if (data.secure_url) return data.secure_url;
  throw new Error('Cloudinary upload failed: ' + JSON.stringify(data));
}

export async function uploadProfileImage(file) {
  const userId = auth.currentUser?.uid;
  if (!userId) throw new Error('Cannot upload profile image: No authenticated user.');
  return cloudinaryUpload(file);
}

export async function uploadMediaAsset({ file, projectId = null, metadata = {}, addToLibrary = true } = {}) {
  const userId = auth.currentUser?.uid;
  if (!userId) throw new Error('Cannot upload media: No authenticated user.');
  if (!file) throw new Error('No file provided for upload.');

  const fileSizeMB = Math.max(file.size / (1024 * 1024), 0.001);
  const { allowed, reason } = await canUploadFile(userId, fileSizeMB);
  if (!allowed) throw new Error(reason || 'Storage limit reached.');

  const resourceType = getCloudinaryResourceType(file);
  const url = await cloudinaryUpload(file, resourceType);
  await updateStorageUsage(userId, fileSizeMB);

  let mediaDoc = null;
  if (addToLibrary) {
    mediaDoc = await addMediaToLibrary({
      ...metadata,
      url,
      name: metadata.name || file.name,
      type: metadata.type || 'reference',
      projectId: metadata.projectId ?? projectId ?? null,
      projectName: metadata.projectName ?? null,
      notes: metadata.notes || '',
      size: file.size,
      mimeType: file.type || null,
      source: metadata.source || null,
    });
  }

  return {
    url,
    mediaDocId: mediaDoc?.id || null,
    sizeMB: fileSizeMB,
    resourceType
  };
}

export function getProfileRef() {
  const userId = auth.currentUser?.uid;
  if (!userId) {
    throw new Error("No authenticated user found.");
  }
  return doc(db, 'users', userId);
}

export function saveProfileData(data) {
  const profileRef = getProfileRef();
  return setDoc(profileRef, data, { merge: true });
}

export function onProfileSnapshot(callback) {
  const userId = auth.currentUser?.uid;
  if (!userId) {
    console.error("No authenticated user found for profile snapshot.");
    return () => {};
  }
  const profileRef = doc(db, 'users', userId);
  return onSnapshot(profileRef, callback);
}

// --- Users & Chats Operations ---
export function getUsersCollectionRef() {
  return collection(db, 'users');
}

export function onUsersSnapshot(callback) {
  const usersRef = getUsersCollectionRef();
  return onSnapshot(usersRef, (snapshot) => {
    const users = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    callback(users);
  }, (error) => {
    console.error("Error fetching users: ", error);
  });
}

export function onChatsSnapshot(callback) {
  const userId = auth.currentUser?.uid;
  if (!userId) {
    console.error("No authenticated user for chats.");
    return () => {};
  }

  const chatsRef = collection(db, 'chats');
  const q = query(
    chatsRef,
    where('participants', 'array-contains', userId),
    orderBy('lastMessageTimestamp', 'desc')
  );
  return onSnapshot(q, (snapshot) => {
    const chats = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    callback(chats);
  }, (error) => {
    console.error("Error fetching chats: ", error);
  });
}

// --- Project Operations ---
export function getProjectsCollectionRef() {
  const userId = auth.currentUser?.uid;
  if (!userId) {
    console.error("No authenticated user found for project operations.");
    return null;
  }
  return collection(db, 'users', userId, 'projects');
}

/**
 * Returns the current user's own projects collection ref.
 * The project list page always shows the authenticated user's own projects;
 * collaborated projects are merged in separately.
 * We deliberately do NOT read ownerId from localStorage here — that value is
 * user-controllable and must never gate which collection we query without a
 * server-side membership check.
 */
function getEffectiveProjectsRef() {
  return getProjectsCollectionRef();
}

/**
 * Returns the correct Firestore ref for a single project, respecting collaboration.
 * Also stores/clears ownerId in localStorage so sub-pages (scenes, breakdown, etc.)
 * that don't receive ownerId in their URL can still find the right path.
 */
/**
 * Returns the current user's collaboration role for the active project.
 * - 'owner'  → user owns the project
 * - 'editor' → collaborator with write access
 * - 'viewer' → collaborator with read-only access
 *
 * The role is derived entirely from server-sourced projectData — we do NOT
 * read ownerId from localStorage or the URL, as those are untrusted.
 *
 * @param {object} projectData - The loaded project document data
 * @returns {'owner'|'editor'|'viewer'}
 */
export function getCollaborationRole(projectData) {
  const uid = auth.currentUser?.uid;
  if (!uid) return 'viewer';

  // If the project's ownerId matches the current user they are the owner.
  if (projectData?.ownerId === uid) return 'owner';

  // Legacy projects may not have an ownerId field — fall back to checking
  // whether the current user appears in the collaborators list.
  const collaborator = (projectData?.collaborators || []).find(c => c.userId === uid);
  if (!collaborator) {
    // Not listed as collaborator; treat as owner only if the project has no
    // ownerId field at all (old data), otherwise default to viewer.
    return !projectData?.ownerId ? 'owner' : 'viewer';
  }
  return collaborator.role === 'editor' ? 'editor' : 'viewer';
}

/**
 * Returns the feature-level permissions object for the current collaborator.
 * A missing key means the feature is allowed (default open).
 * A key explicitly set to false means the owner has blocked that feature.
 * Returns null if the current user is the owner (no restrictions apply).
 *
 * Ownership is determined from server-sourced projectData.ownerId, not
 * from localStorage or the URL.
 *
 * @param {object} projectData
 * @returns {object|null}
 */
export function getCollaboratorFeaturePermissions(projectData) {
  const uid = auth.currentUser?.uid;
  if (!uid) return {};

  // Owner has no restrictions.
  if (projectData?.ownerId === uid || !projectData?.ownerId) return null;

  const collaborator = (projectData?.collaborators || []).find(c => c.userId === uid);
  return collaborator?.featurePermissions || {};
}

/**
 * Normalises a raw permission value to { access, edit }.
 * Handles both the old boolean format and the new object format.
 *   old: true/false          → { access: true/false, edit: true/false }
 *   new: { access, edit }    → returned as-is
 *   missing (undefined/null) → { access: true, edit: true }  (default open)
 * @param {*} raw
 * @returns {{ access: boolean, edit: boolean }}
 */
export function normalisePermission(raw) {
  if (raw === null || raw === undefined) return { access: true, edit: true };
  if (typeof raw === 'boolean')          return { access: raw, edit: raw };
  if (typeof raw === 'object')           return { access: raw.access !== false, edit: raw.edit !== false };
  return { access: true, edit: true };
}

/**
 * Check if the current collaborator can ACCESS (open/view) a specific feature.
 * Returns false only when access is explicitly denied.
 * @param {object} projectData
 * @param {string} featureKey  e.g. 'screenplay', 'budget', 'castCrew'
 * @returns {boolean}
 */
export function hasFeatureAccess(projectData, featureKey) {
  const perms = getCollaboratorFeaturePermissions(projectData);
  if (perms === null) return true; // owner — unrestricted
  return normalisePermission(perms[featureKey]).access;
}

/**
 * Check if the current collaborator can EDIT (make changes in) a specific feature.
 * Returns false when edit is explicitly denied, or when access itself is denied.
 * @param {object} projectData
 * @param {string} featureKey
 * @returns {boolean}
 */
export function hasFeatureEdit(projectData, featureKey) {
  const perms = getCollaboratorFeaturePermissions(projectData);
  if (perms === null) return true; // owner — unrestricted
  const p = normalisePermission(perms[featureKey]);
  return p.access && p.edit;
}

/**
 * Returns the correct Firestore ref for a single project, respecting collaboration.
 *
 * Security model:
 *  - The ownerId hint (URL param or localStorage) is UNTRUSTED user input.
 *  - Before routing reads/writes to another user's project path, we fetch the
 *    project document and confirm that auth.currentUser.uid appears in the
 *    document's `collaboratorIds` array.  Firestore rules already block
 *    unauthorised writes, but this client-side check prevents leaking the
 *    existence of a project to a non-member and avoids unnecessary reads.
 *  - If the membership check fails we fall back to the current user's own
 *    path (where Firestore rules will correctly deny access if the project
 *    doesn't belong to them).
 *
 * Because the check is async this function returns a Promise<DocumentReference|null>.
 *
 * @param {string} projectId
 * @returns {Promise<import('firebase/firestore').DocumentReference|null>}
 */
export async function getEffectiveProjectRef(projectId) {
  const uid = auth.currentUser?.uid;
  if (!uid) return null;

  // Resolve the claimed ownerId — URL param takes precedence over localStorage,
  // but we must verify it before trusting either.
  const urlParams = new URLSearchParams(window.location.search);
  const claimedOwnerId = urlParams.get('ownerId') || localStorage.getItem('currentProjectOwnerId');

  if (claimedOwnerId && claimedOwnerId !== uid) {
    // Verify the current user is actually a collaborator on this project.
    const candidateRef = doc(db, 'users', claimedOwnerId, 'projects', projectId);
    try {
      const snap = await getDoc(candidateRef);
      if (snap.exists()) {
        const data = snap.data();
        const collaboratorIds = Array.isArray(data.collaboratorIds) ? data.collaboratorIds : [];
        if (collaboratorIds.includes(uid)) {
          // Confirmed member — safe to persist and use this path.
          localStorage.setItem('currentProjectOwnerId', claimedOwnerId);
          return candidateRef;
        }
      }
    } catch (e) {
      // Firestore denied the read (rules) or the doc doesn't exist — fall through.
      console.warn('getEffectiveProjectRef: membership check failed, falling back to own path.', e);
    }

    // The claimed ownerId could not be verified; discard it.
    localStorage.removeItem('currentProjectOwnerId');
  } else if (!claimedOwnerId) {
    // No hint at all — clear any stale value.
    localStorage.removeItem('currentProjectOwnerId');
  }

  return doc(db, 'users', uid, 'projects', projectId);
}

export async function getProjectDetails(projectId) {
  try {
    const projectRef = await getEffectiveProjectRef(projectId);
    if (!projectRef) {
      throw new Error("No authenticated user found.");
    }
    const projectDoc = await getDoc(projectRef);
    if (projectDoc.exists()) {
      return { id: projectDoc.id, ...projectDoc.data() };
    } else {
      console.warn("Project document does not exist:", projectId);
      return null;
    }
  } catch (error) {
    console.error("Error getting project details:", error);
    return null;
  }
}

export function onProjectsSnapshot(callback) {
  // For the project list page, always show the current user's own projects
  // (collaborated projects are merged in separately by project_folder.js)
  const projectsRef = getProjectsCollectionRef();
  if (!projectsRef) {
    return () => {};
  }
  const q = query(projectsRef, orderBy('createdAt', 'desc'), limit(100));
  return onSnapshot(q, async (snapshot) => {
    // One-time backfill: ensure collaborative projects have the flat
    // collaboratorIds / collaboratorRoles arrays the Firestore rules rely on.
    // We check for the `collaboratorIdsBackfilled` sentinel to avoid re-running
    // this on every snapshot update, which would create a write storm.
    const backfills = [];
    snapshot.docs.forEach(d => {
      const data = d.data();
      if (
        data.isCollaborative &&
        Array.isArray(data.collaborators) &&
        data.collaborators.length > 0 &&
        !Array.isArray(data.collaboratorIds) &&
        !data.collaboratorIdsBackfilled // sentinel — skip if already done
      ) {
        const collaboratorIds = data.collaborators.map(c => c.userId);
        const collaboratorRoles = Object.fromEntries(data.collaborators.map(c => [c.userId, c.role]));
        backfills.push(
          updateDoc(d.ref, {
            collaboratorIds,
            collaboratorRoles,
            collaboratorIdsBackfilled: true // mark done so this never runs again
          })
        );
      }
    });
    if (backfills.length > 0) {
      await Promise.all(backfills).catch(e => console.warn('collaboratorIds backfill failed:', e));
    }
    callback(snapshot);
  });
}

export function onProjectSnapshot(projectId, callback, errorCallback) {
  // Use effective ref — handles collaborator viewing owner's project.
  // getEffectiveProjectRef is async (performs a membership check), so we
  // resolve the ref and then set up the real snapshot listener.  We return
  // a synchronous unsubscribe function whose inner unsub is swapped in once
  // the promise resolves.
  let unsub = () => {};
  getEffectiveProjectRef(projectId).then(projectRef => {
    if (!projectRef) {
      if (errorCallback) errorCallback(new Error("No authenticated user."));
      return;
    }
    unsub = onSnapshot(projectRef, callback, errorCallback);
  }).catch(err => {
    if (errorCallback) errorCallback(err);
  });
  return () => unsub();
}

export async function addProject(projectData) {
  const uid = auth.currentUser?.uid;
  const projectsRef = getProjectsCollectionRef();
  if (!projectsRef || !uid) {
    throw new Error("Cannot add project: No authenticated user.");
  }
  // Create the project document and atomically increment the owner's project counter.
  // The Firestore rule reads 'ownedProjectCount' to enforce the free-tier limit,
  // so this counter must be kept in sync with actual owned project documents.
  const docRef = await addDoc(projectsRef, projectData);
  await updateDoc(doc(db, 'users', uid), {
    ownedProjectCount: increment(1)
  });
  return docRef;
}

export async function updateProject(projectId, newData) {
  // Use effective ref — allows editors to save to the owner's project path
  const projectRef = await getEffectiveProjectRef(projectId);
  if (!projectRef) {
    throw new Error("Cannot update project: No authenticated user.");
  }
  return updateDoc(projectRef, newData);
}

export async function deleteProject(projectId) {
  const uid = auth.currentUser?.uid;
  const projectsRef = getProjectsCollectionRef();
  if (!projectsRef || !uid) {
    throw new Error("Cannot delete project: No authenticated user.");
  }
  const projectRef = doc(projectsRef, projectId);
  await deleteDoc(projectRef);
  // Decrement the counter — clamp at 0 to prevent negative values on legacy accounts
  // that were created before this counter existed.
  await updateDoc(doc(db, 'users', uid), {
    ownedProjectCount: increment(-1)
  }).catch(() => {
    // Non-fatal — counter drift is corrected on next project creation check
    console.warn('deleteProject: could not decrement ownedProjectCount');
  });
}

// --- Share Operations ---
export async function createSharedProjectEntry(projectId) {
    const projectsRef = getProjectsCollectionRef();
    if (!projectsRef) {
        throw new Error("Cannot share project: No authenticated user.");
    }
    const projectRef = doc(projectsRef, projectId);
    const projectSnap = await getDoc(projectRef);
    if (projectSnap.exists()) {
        const projectData = projectSnap.data();
        const sharedProjectsCollection = collection(db, "sharedProjects");
        // Create a new document in the shared collection
        const newSharedDocRef = await addDoc(sharedProjectsCollection, {
            ...projectData,
            sharedBy: auth.currentUser.uid,
            createdAt: serverTimestamp() 
        });
        // Copy subcollections using a batch operation
        const subcollectionsToShare = ['cast', 'crew', 'storyboards'];
        const batch = writeBatch(db);

        for (const type of subcollectionsToShare) {
            const privateSubcollectionRef = collection(projectsRef, projectId, type);
            const privateSubcollectionSnap = await getDocs(privateSubcollectionRef);
            
            const sharedSubcollectionRef = collection(newSharedDocRef, type);
            privateSubcollectionSnap.docs.forEach(subDoc => {
                const docRef = doc(sharedSubcollectionRef, subDoc.id);
                batch.set(docRef, subDoc.data());
            });
        }
        
        await batch.commit();
        
        return newSharedDocRef.id;
    } else {
        throw new Error("Project not found.");
    }
}

// --- NEW FUNCTION: Add a shared project to a user's account ---
export async function addSharedProjectToUser(userId, shareId) {
    // 1. Get the shared project and its subcollections from the public 'sharedProjects' collection
    const sharedProjectRef = doc(db, "sharedProjects", shareId);
    const sharedProjectSnap = await getDoc(sharedProjectRef);

    if (!sharedProjectSnap.exists()) {
        console.error("Shared project not found!");
        throw new Error("Shared project not found.");
    }

    const sharedProjectData = sharedProjectSnap.data();
    const userProjectsCollectionRef = collection(db, "users", userId, "projects");
    
    // Check if the user already has this project from this shareId
    const q = query(userProjectsCollectionRef, where('sharedFrom', '==', shareId));
    const existingProjectsSnap = await getDocs(q);

    let newUserProjectRef;
    if (!existingProjectsSnap.empty) {
        // Project already exists, get the reference to the first one found
        const existingDoc = existingProjectsSnap.docs[0];
        newUserProjectRef = doc(userProjectsCollectionRef, existingDoc.id);
        
        // Update the existing project with new data
        await updateDoc(newUserProjectRef, {
            ...sharedProjectData,
            createdAt: serverTimestamp(), // Update the timestamp
            sharedFrom: shareId
        });
        console.log(`Successfully updated existing shared project in user ${userId}'s account.`);

    } else {
        // Project doesn't exist, create a new one
        newUserProjectRef = await addDoc(userProjectsCollectionRef, {
            ...sharedProjectData,
            createdAt: serverTimestamp(),
            sharedFrom: shareId // Add a 'sharedFrom' field to track the source
        });
        console.log(`Successfully added a new shared project to user ${userId}'s account.`);
    }

    // Copy the subcollections from the public shared project to the new/updated user's private project
    const subcollectionsToCopy = ['cast', 'crew', 'storyboards'];
    const batch = writeBatch(db);

    for (const type of subcollectionsToCopy) {
        const sharedSubcollectionRef = collection(sharedProjectRef, type);
        const sharedSubcollectionSnap = await getDocs(sharedSubcollectionRef);

        const newUserSubcollectionRef = collection(newUserProjectRef, type);
        sharedSubcollectionSnap.docs.forEach(subDoc => {
            const docRef = doc(newUserSubcollectionRef, subDoc.id);
            batch.set(docRef, subDoc.data());
        });
    }

    await batch.commit();
}

// --- Collaboration Operations ---

async function enforceTeamCollaborationAccess() {
  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error('No authenticated user.');

  const userRef = doc(db, 'users', currentUser.uid);
  // Use getDocFromServer to bypass IndexedDB cache — plan must be authoritative
  const userSnap = await getDocFromServer(userRef);
  const plan = userSnap.exists() ? (userSnap.data()?.plan || 'free') : 'free';

  if (!getPlanConfig(plan).features.teamCollaboration) {
    throw new Error('Team collaboration is a Pro feature. Upgrade to Pro to invite collaborators and share projects.');
  }
}

/**
 * Invite a collaborator to a project by email.
 * - If the user exists: adds them as collaborator and sends a notification email.
 * - If the user doesn't exist: sends a signup invitation email instead.
 * @param {string} projectId - The project to share
 * @param {string} inviteeEmail - Email of the user to invite
 * @param {string} role - 'viewer' or 'editor'
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function inviteCollaborator(projectId, inviteeEmail, role = 'viewer') {

  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error("No authenticated user.");

  const inviterName = currentUser.displayName || currentUser.email;
  const { getBackendBaseUrl } = await import('./config.js');
  const API_BASE = getBackendBaseUrl();

  // Get the project to verify ownership and check collaborator list/limits
  const projectsRef = getProjectsCollectionRef();
  if (!projectsRef) throw new Error("Cannot access projects.");
  const projectRef = doc(projectsRef, projectId);
  const projectSnap = await getDoc(projectRef);

  if (!projectSnap.exists()) {
    return { success: false, message: 'Project not found.' };
  }

  const projectData = projectSnap.data();
  const collaborators = projectData.collaborators || [];
  const normalizedEmail = inviteeEmail.toLowerCase().trim();

  // Check if already a collaborator
  if (collaborators.some(c => c.email.toLowerCase().trim() === normalizedEmail)) {
    return { success: false, message: 'This user is already a collaborator.' };
  }

  // ── Plan gate & collaborator limit check ──────────────────────────────────
  let ownerPlan = 'free';
  try {
    const ownerRef = doc(collection(db, 'users'), currentUser.uid);
    const ownerSnap = await getDoc(ownerRef);
    const rawPlan = ownerSnap.exists() ? (ownerSnap.data().plan || 'free') : 'free';
    const planAliases = { premium: 'pro', paid: 'pro' };
    const basePlan = rawPlan.toLowerCase().replace(/-(monthly|yearly|annual)$/, '');
    ownerPlan = planAliases[basePlan] || basePlan;

    if (ownerPlan === 'free') {
      return {
        success: false,
        message: 'Team collaboration is a Pro feature. Upgrade to Pro to invite collaborators.',
        upgradeRequired: true,
        requiredPlan: 'pro'
      };
    }

    const maxTeamMembers = ownerPlan === 'studio' ? 15 : 5;
    if (collaborators.length >= maxTeamMembers) {
      return {
        success: false,
        message: `Collaborator limit reached. Your ${ownerPlan.toUpperCase()} plan allows up to ${maxTeamMembers} collaborators. Upgrade to a higher plan for more slots.`,
        limitReached: true,
        maxTeamMembers
      };
    }
  } catch (planCheckError) {
    console.error('[inviteCollaborator] Plan check failed:', planCheckError);
    return { success: false, message: 'Could not verify plan. Please try again.' };
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Find the invitee by email — try lowercase first (normalized), then original casing
  // as a fallback since Firebase Auth may store emails in their original case.
  const usersRef = collection(db, 'users');
  let snapshot = await getDocs(query(usersRef, where('email', '==', normalizedEmail)));
  if (snapshot.empty && inviteeEmail.trim() !== normalizedEmail) {
    snapshot = await getDocs(query(usersRef, where('email', '==', inviteeEmail.trim())));
  }

  // --- Case 1: User does NOT exist on PREP — send signup invitation email ---
  if (snapshot.empty) {
    const projectName = projectData ? projectData.name : 'a project';

    // Send invite email via server — attach the inviter's ID token so the
    // /api/collaboration/invite endpoint can verify the caller is authenticated.
    try {
      const idToken = await currentUser.getIdToken();
      const emailRes = await fetch(`${API_BASE}/api/collaboration/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({
          projectId,
          inviteeEmail: normalizedEmail,
          projectName,
          role,
          userExists: false,
          signupLink: 'https://prepapp.name.ng/signup.html'
        })
      });
      if (!emailRes.ok) {
        const errData = await emailRes.json().catch(() => ({}));
        console.warn('Invite email server error:', errData.message || emailRes.status);
      }
    } catch (emailErr) {
      console.warn('Invite email failed (non-blocking):', emailErr);
    }

    return {
      success: false,
      message: `No PREP account found for ${inviteeEmail}. An invitation email has been sent asking them to sign up.`,
      invited: true
    };
  }

  // --- Case 2: User EXISTS on PREP ---
  const inviteeDoc = snapshot.docs[0];
  const inviteeId = inviteeDoc.id;
  const inviteeData = inviteeDoc.data();

  if (inviteeId === currentUser.uid) {
    return { success: false, message: "You can't invite yourself." };
  }

  // Check if already a collaborator by UID (defense in depth)
  if (collaborators.some(c => c.userId === inviteeId)) {
    return { success: false, message: 'This user is already a collaborator.' };
  }

  // Add collaborator to project
  const newCollaborator = {
    userId: inviteeId,
    email: inviteeEmail.toLowerCase().trim(),
    displayName: inviteeData.displayName || inviteeData.fullName || inviteeEmail,
    role: role,
    addedAt: new Date().toISOString(),
    addedBy: currentUser.uid
  };

  const updatedCollaborators = [...collaborators, newCollaborator];
  const collaboratorRoles = Object.fromEntries(updatedCollaborators.map(c => [c.userId, c.role]));
  await updateDoc(projectRef, {
    collaborators: updatedCollaborators,
    collaboratorIds: updatedCollaborators.map(c => c.userId),
    collaboratorRoles,
    isCollaborative: true
  });

  // Add a reference in the invitee's collaboratedProjects subcollection.
  // Use projectId as the document ID so Firestore rules can verify membership
  // with a simple exists() check without needing a query.
  const collaboratedRef = collection(db, 'users', inviteeId, 'collaboratedProjects');
  const entryRef = doc(collaboratedRef, projectId);
  const existingSnap = await getDoc(entryRef);

  if (!existingSnap.exists()) {
    await setDoc(entryRef, {
      projectId: projectId,
      ownerId: currentUser.uid,
      ownerEmail: currentUser.email,
      ownerName: inviterName,
      projectName: projectData.name,
      role: role,
      addedAt: serverTimestamp(),
      seen: false
    });
  }

  // Write in-app notification for the invitee
  await createNotification(inviteeId, {
    type: 'collab_invite',
    title: 'You were added to a project',
    body: `${inviterName} added you as a ${role} on "${projectData.name}"`,
    icon: 'fa-users',
    link: `project_folder.html`,
    meta: { projectId, ownerId: currentUser.uid, role }
  });

  // Send notification email to the existing user (non-blocking)
  try {
    const idToken = await currentUser.getIdToken();
    await fetch(`${API_BASE}/api/collaboration/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({
        inviteeEmail: inviteeEmail.toLowerCase().trim(),
        inviteeName: inviteeData.displayName || inviteeData.fullName || null,
        projectName: projectData.name,
        role,
        userExists: true
      })
    });
  } catch (emailErr) {
    console.warn('Notification email failed (non-blocking):', emailErr);
  }

  return {
    success: true,
    message: `${inviteeData.displayName || inviteeData.fullName || inviteeEmail} has been added as a ${role}. A notification email has been sent.`
  };
}

/**
 * Remove a collaborator from a project.
 * @param {string} projectId - The project
 * @param {string} collaboratorUserId - The user to remove
 */
export async function removeCollaborator(projectId, collaboratorUserId) {
  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error("No authenticated user.");

  const projectsRef = getProjectsCollectionRef();
  if (!projectsRef) throw new Error("Cannot access projects.");
  const projectRef = doc(projectsRef, projectId);
  const projectSnap = await getDoc(projectRef);

  if (!projectSnap.exists()) throw new Error("Project not found.");

  const collaborators = (projectSnap.data().collaborators || []).filter(
    c => c.userId !== collaboratorUserId
  );
  const collaboratorRoles = Object.fromEntries(collaborators.map(c => [c.userId, c.role]));
  await updateDoc(projectRef, {
    collaborators,
    collaboratorIds: collaborators.map(c => c.userId),
    collaboratorRoles,
    isCollaborative: collaborators.length > 0
  });

  // Remove from invitee's collaboratedProjects
  const collaboratedRef = collection(db, 'users', collaboratorUserId, 'collaboratedProjects');
  const q = query(collaboratedRef, where('projectId', '==', projectId));
  const snap = await getDocs(q);
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

/**
 * Get all projects the current user has been invited to collaborate on.
 * Returns an array of project objects from other users' collections.
 * Uses Promise.all for parallel fetches instead of sequential awaits.
 */
export async function getCollaboratedProjects() {
  const userId = auth.currentUser?.uid;
  if (!userId) return [];

  try {
    const collaboratedRef = collection(db, 'users', userId, 'collaboratedProjects');
    const snap = await getDocs(collaboratedRef);

    if (snap.empty) return [];

    // Migrate old random-ID entries to use projectId as the document ID in parallel.
    // This is required so the Firestore rule exists() check works correctly.
    const migrationBatch = writeBatch(db);
    let hasMigrations = false;
    snap.docs.forEach(entry => {
      const { projectId } = entry.data();
      if (projectId && entry.id !== projectId) {
        migrationBatch.set(doc(collaboratedRef, projectId), entry.data(), { merge: true });
        migrationBatch.delete(entry.ref);
        hasMigrations = true;
      }
    });
    if (hasMigrations) {
      await migrationBatch.commit().catch(e => console.warn('collaboratedProjects migration failed:', e));
    }

    // Fetch all project docs in parallel instead of sequentially.
    const fetchResults = await Promise.allSettled(
      snap.docs.map(async (entry) => {
        const entryData = entry.data();
        const { projectId, ownerId, role, ownerName, ownerEmail } = entryData;
        if (!projectId || !ownerId) return null;

        const projectRef = doc(db, 'users', ownerId, 'projects', projectId);
        const projectSnap = await getDoc(projectRef);
        if (!projectSnap.exists()) return null;

        return {
          id: projectSnap.id,
          ...projectSnap.data(),
          _isCollaborated: true,
          _collaborationRole: role,
          _ownerId: ownerId,
          _ownerName: ownerName || ownerEmail || 'Someone'
        };
      })
    );

    return fetchResults
      .filter(r => r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value);

  } catch (error) {
    console.error('Error fetching collaborated projects:', error);
    return [];
  }
}

// --- Cast & Crew Operations ---
export async function getCastCrewCollectionRef(projectId, type) {
  if (type !== 'cast' && type !== 'crew') {
    console.error("Invalid type provided. Must be 'cast' or 'crew'.");
    return null;
  }
  const projectRef = await getEffectiveProjectRef(projectId);
  if (!projectRef) return null;
  return collection(projectRef, type);
}

// NEW FUNCTION: Use this to get the shared collection reference
export function getSharedCastCrewCollectionRef(projectId, type) {
  if (type !== 'cast' && type !== 'crew') {
    console.error("Invalid type provided. Must be 'cast' or 'crew'.");
    return null;
  }
  // UPDATED: Changed 'shared_projects' to 'sharedProjects' to match other functions
  return collection(db, 'sharedProjects', projectId, type);
}

export async function addCastCrewMember(projectId, type, memberData) {
  console.log(`[addCastCrewMember] Adding ${type} member to project ${projectId}`, memberData);
  const collectionRef = await getCastCrewCollectionRef(projectId, type);
  if (!collectionRef) throw new Error("Cannot add member.");
  return addDoc(collectionRef, {
    ...memberData,
    createdAt: new Date()
  });
}

export function onCastCrewSnapshot(projectId, type, callback) {
  // Check if a user is authenticated.
  // If not, assume it's the shared page and use the public path.
  if (!auth.currentUser?.uid) {
    const collectionRef = getSharedCastCrewCollectionRef(projectId, type);
    if (!collectionRef) return () => {};
    const q = query(collectionRef, orderBy('name', 'asc'));
    return onSnapshot(q, callback);
  }

  // Authenticated path: resolve the verified ref asynchronously, then subscribe.
  let unsub = () => {};
  getCastCrewCollectionRef(projectId, type).then(collectionRef => {
    if (!collectionRef) return;
    const q = query(collectionRef, orderBy('name', 'asc'));
    unsub = onSnapshot(q, callback);
  });
  return () => unsub();
}

export async function updateCastCrewMember(projectId, type, memberId, newData) {
  const collectionRef = await getCastCrewCollectionRef(projectId, type);
  if (!collectionRef) throw new Error("Cannot update member.");
  const memberDocRef = doc(collectionRef, memberId);
  return updateDoc(memberDocRef, newData);
}

export async function deleteCastCrewMember(projectId, type, memberId) {
  const collectionRef = await getCastCrewCollectionRef(projectId, type);
  if (!collectionRef) throw new Error("Cannot delete member.");
  const memberDocRef = doc(collectionRef, memberId);
  return deleteDoc(memberDocRef);
}

// --- Storyboard Operations ---
export async function getStoryboardsCollectionRef(projectId) {
  const projectRef = await getEffectiveProjectRef(projectId);
  if (!projectRef) return null;
  return collection(projectRef, 'storyboards');
}

export function onStoryboardsSnapshot(projectId, callback) {
  let unsub = () => {};
  getStoryboardsCollectionRef(projectId).then(storyboardsRef => {
    if (!storyboardsRef) return;
    const q = query(storyboardsRef, orderBy('createdAt', 'asc'));
    unsub = onSnapshot(q, callback);
  });
  return () => unsub();
}

export async function addStoryboardPanel(projectId, panelData) {
  const storyboardsRef = await getStoryboardsCollectionRef(projectId);
  if (!storyboardsRef) throw new Error("Cannot add storyboard panel.");
  return addDoc(storyboardsRef, panelData);
}

export async function updateStoryboardPanel(projectId, panelId, newData) {
  const storyboardsRef = await getStoryboardsCollectionRef(projectId);
  if (!storyboardsRef) throw new Error("Cannot update storyboard panel.");
  const panelRef = doc(storyboardsRef, panelId);
  return updateDoc(panelRef, newData);
}

export async function deleteStoryboardPanel(projectId, panelId) {
  const storyboardsRef = await getStoryboardsCollectionRef(projectId);
  if (!storyboardsRef) throw new Error("Cannot delete storyboard panel.");
  const panelRef = doc(storyboardsRef, panelId);
  return deleteDoc(panelRef);
}

// --- Images Operations (Cloudinary) ---
export async function uploadImage(projectId, file) {
  const userId = auth.currentUser?.uid;
  if (!userId) throw new Error('Cannot upload image: No authenticated user.');
  return cloudinaryUpload(file);
}

export async function uploadCastProfileImage(projectId, file) {
  const userId = auth.currentUser?.uid;
  if (!userId) throw new Error('Cannot upload image: No authenticated user.');
  return cloudinaryUpload(file);
}

export async function deleteImage(imageUrl) {
  console.warn("⚠️ Cloudinary unsigned uploads cannot be deleted directly from client. Remove Firestore reference instead:", imageUrl);
}

// --- Analytics Operations (NEW) ---
const mainAppId = 'main-app-id'; // Use a consistent ID for the main app
const analyticsEventsRef = collection(db, `artifacts/${mainAppId}/public/data/analytics_events`);
/**
 * Logs an analytics event to a designated Firestore collection.
 * This is now the main function for logging events from the user-facing app.
 * @param {string} eventType - The type of event (e.g., 'session_start', 'feature_use').
 * @param {object} eventDetails - Optional details about the event.
 */
export async function logAnalyticsEvent(eventType, eventDetails = {}) {
  const user = auth.currentUser;

  // If there's no authenticated user, queue the event locally so it can
  // be flushed after the user signs in. Firestore rules require auth for
  // writes to the analytics path, so we must not attempt to write here.
  if (!user) {
    try {
      const queued = JSON.parse(localStorage.getItem('pending_analytics') || '[]');
      queued.push({
        eventType,
        eventDetails: { ...eventDetails },
        timestamp: new Date().toISOString()
      });
      localStorage.setItem('pending_analytics', JSON.stringify(queued));
      console.debug('Queued analytics event for unauthenticated user:', eventType);
    } catch (e) {
      console.warn('Failed to queue analytics event:', e);
    }
    return;
  }

  const userId = user.uid;
  try {
    await addDoc(analyticsEventsRef, {
      userId,
      eventType,
      timestamp: Timestamp.now(),
      ...eventDetails,
    });
    console.log(`Analytics event logged: ${eventType}`);
  } catch (e) {
    console.error("Error logging analytics event: ", e);
  }
}

/**
 * Flush any analytics events queued in localStorage by writing them to Firestore.
 * Called after a user signs in. Converts stored ISO timestamps to Firestore Timestamps.
 */
export async function flushPendingAnalytics() {
  const user = auth.currentUser;
  if (!user) return;

  const raw = localStorage.getItem('pending_analytics');
  if (!raw) return;

  let queued;
  try {
    queued = JSON.parse(raw);
    if (!Array.isArray(queued) || queued.length === 0) {
      localStorage.removeItem('pending_analytics');
      return;
    }
  } catch (e) {
    console.warn('Malformed pending_analytics data; clearing.', e);
    localStorage.removeItem('pending_analytics');
    return;
  }

  for (const ev of queued) {
    try {
      const docData = {
        userId: user.uid,
        eventType: ev.eventType,
        timestamp: ev.timestamp ? Timestamp.fromDate(new Date(ev.timestamp)) : serverTimestamp(),
        ...ev.eventDetails
      };
      await addDoc(analyticsEventsRef, docData);
    } catch (e) {
      console.warn('Failed to flush analytics event, stopping flush to avoid rapid retries:', e);
      return;
    }
  }

  localStorage.removeItem('pending_analytics');
  console.log('Flushed pending analytics events.');
}

/**
 * Log a user activity to the user_activities collection for admin visibility
 * Tracks significant user actions within projects and features
 * @param {string} activityType - Type of activity (e.g., 'project_created', 'storyboard_added', 'scene_edited')
 * @param {object} activityData - Details about the activity
 */
export async function logUserActivity(activityType, activityData = {}) {
  const userId = auth.currentUser?.uid;
  if (!userId) return; // Only log for authenticated users

  try {
    const activitiesRef = collection(db, 'users', userId, 'user_activities');
    await addDoc(activitiesRef, {
      activityType,
      timestamp: serverTimestamp(),
      ...activityData,
      // Auto-populate browser/device info if not provided
      userAgent: activityData.userAgent || navigator.userAgent,
      url: activityData.url || window.location.href
    });
    console.log(`User activity logged: ${activityType}`);
  } catch (e) {
    console.warn('Failed to log user activity:', e);
  }
}

// --- Subscription & Payment Operations ---

/**
 * Get user's current subscription plan
 * @param {string} userId - User ID
 * @returns {Promise<string>} Plan type: 'free', 'pro', or 'studio'
 */
export async function getUserSubscriptionPlan(userId) {
  try {
    if (!userId) {
      return 'free';
    }
    const userRef = doc(db, 'users', userId);
    const userDoc = await getDocFromServer(userRef);
    const plan = userDoc.data()?.plan || 'free';
    return plan;
  } catch (error) {
    console.error('Error fetching user subscription plan:', error);
    return 'free';
  }
}

/**
 * Get full subscription details for a user
 * @param {string} userId - User ID
 * @returns {Promise<object>} Subscription details
 */
export async function getUserSubscriptionDetails(userId) {
  try {
    if (!userId) {
      return { plan: 'free', status: 'inactive' };
    }
    const userRef = doc(db, 'users', userId);
    const userDoc = await getDocFromServer(userRef);
    const data = userDoc.data() || {};
    
    return {
      plan: data.plan || 'free',
      subscriptionId: data.subscriptionId || null,
      status: data.subscriptionStatus || 'inactive',
      startDate: data.subscriptionStartDate || null,
      endDate: data.subscriptionEndDate || null,
      lastPaymentDate: data.lastPaymentDate || null
    };
  } catch (error) {
    console.error('Error fetching subscription details:', error);
    return { plan: 'free', status: 'inactive' };
  }
}

/**
 * Update user subscription after successful payment
 * @param {string} userId - User ID
 * @param {string} plan - Plan type ('pro' or 'studio')
 * @param {string} subscriptionId - Paystack subscription/transaction reference
 * @returns {Promise<object>} Updated subscription data
 */
export async function updateSubscriptionAfterPayment(userId, plan, subscriptionId) {
  try {
    const userRef = doc(db, 'users', userId);
    const now = new Date();
    const endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

    const subscriptionData = {
      plan: plan,
      subscriptionId: subscriptionId,
      subscriptionStatus: 'active',
      subscriptionStartDate: serverTimestamp(),
      subscriptionEndDate: endDate,
      lastPaymentDate: serverTimestamp()
    };

    await updateDoc(userRef, subscriptionData);

    // Log payment history
    const paymentsCollectionRef = collection(db, 'users', userId, 'payments');
    await addDoc(paymentsCollectionRef, {
      subscriptionId: subscriptionId,
      plan: plan,
      amount: plan === 'pro' ? 5 : 0,
      currency: 'USD',
      status: 'successful',
      paymentDate: serverTimestamp(),
      expiryDate: endDate
    });

    // Log analytics event
    await logAnalyticsEvent('subscription_upgraded', { 
      plan: plan,
      subscriptionId: subscriptionId
    });

    return subscriptionData;
  } catch (error) {
    console.error('Error updating subscription:', error);
    throw error;
  }
}

/**
 * Check if subscription is still valid
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} True if subscription is active and not expired
 */
export async function isSubscriptionActive(userId) {
  try {
    const details = await getUserSubscriptionDetails(userId);
    
    if (details.status !== 'active' || !details.endDate) {
      return false;
    }

    const endDate = details.endDate.toDate ? details.endDate.toDate() : new Date(details.endDate);
    return new Date() < endDate;
  } catch (error) {
    console.error('Error checking subscription status:', error);
    return false;
  }
}

/**
 * Get payment history for a user
 * @param {string} userId - User ID
 * @returns {Promise<array>} Array of payment records
 */
export async function getPaymentHistory(userId) {
  try {
    if (!userId) {
      return [];
    }
    const paymentsRef = collection(db, 'users', userId, 'payments');
    const q = query(paymentsRef, orderBy('paymentDate', 'desc'));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error('Error fetching payment history:', error);
    return [];
  }
}

/**
 * Cancel user subscription
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} True if cancellation was successful
 */
export async function cancelSubscription(userId) {
  try {
    const userRef = doc(db, 'users', userId);
    await updateDoc(userRef, {
      plan: 'free',
      subscriptionStatus: 'cancelled',
      subscriptionId: null
    });

    await logAnalyticsEvent('subscription_cancelled', { userId });
    return true;
  } catch (error) {
    console.error('Error cancelling subscription:', error);
    return false;
  }
}

// --- Storage Usage Tracking ---

/**
 * Get user's current storage usage
 * @param {string} userId - User ID
 * @returns {Promise<object>} { usedMB, plan, maxMB, percentUsed }
 */
export async function getStorageUsage(userId) {
  try {
    if (!userId) {
      return { usedMB: 0, plan: 'free', maxMB: 50, percentUsed: 0 };
    }
    
    const userRef = doc(db, 'users', userId);
    const userDoc = await getDocFromServer(userRef);
    const data = userDoc.data() || {};
    
    const plan = data.plan || 'free';
    // Normalise billing-period suffixes (e.g. "studio-yearly" → "studio")
    const normPlan = plan.toLowerCase().replace(/-(monthly|yearly|annual)$/, '');
    const usedMB = data.storageUsedMB || 0;
    const maxMB = normPlan === 'free' ? 50 : normPlan === 'pro' ? 500 : 2000;
    const percentUsed = Math.round((usedMB / maxMB) * 100);
    
    return { usedMB, plan: normPlan, maxMB, percentUsed };
  } catch (error) {
    console.error('Error getting storage usage:', error);
    return { usedMB: 0, plan: 'free', maxMB: 50, percentUsed: 0 };
  }
}

/**
 * Check if upload is allowed (before uploading)
 * @param {string} userId - User ID
 * @param {number} fileSizeMB - File size in MB
 * @returns {Promise<object>} { allowed: boolean, reason?: string }
 */
export async function canUploadFile(userId, fileSizeMB) {
  try {
    const storage = await getStorageUsage(userId);
    const wouldExceed = storage.usedMB + fileSizeMB > storage.maxMB;
    
    if (wouldExceed) {
      return {
        allowed: false,
        reason: `File would exceed storage limit. You have ${storage.maxMB - storage.usedMB}MB available.`
      };
    }
    
    return { allowed: true };
  } catch (error) {
    console.error('Error checking upload allowance:', error);
    return { allowed: false, reason: 'Unable to check storage limits' };
  }
}

/**
 * Update storage usage after file upload
 * @param {string} userId - User ID
 * @param {number} fileSizeMB - File size in MB to add
 * @returns {Promise<object>} Updated storage info
 */
export async function updateStorageUsage(userId, fileSizeMB) {
  try {
    const userRef = doc(db, 'users', userId);

    // Use atomic increment to avoid race conditions from concurrent uploads
    await updateDoc(userRef, {
      storageUsedMB: increment(fileSizeMB),
      lastStorageUpdateAt: serverTimestamp()
    });
    
    await logAnalyticsEvent('file_uploaded', { sizeMB: fileSizeMB });
    
    return getStorageUsage(userId);
  } catch (error) {
    console.error('Error updating storage usage:', error);
    throw error;
  }
}

// --- Plan Management & Downgrade Handling ---

/**
 * Handle plan downgrade from Pro to Free
 * Archives excess projects when user downgrades from Pro to Free plan
 * @param {string} userId - User ID
 * @returns {Promise<object>} Downgrade result with archived projects
 */
export async function handlePlanDowngrade(userId) {
  try {
    if (!userId) {
      throw new Error('User ID is required');
    }

    // Get all user's projects with creation timestamps
    const projectsRef = collection(db, 'users', userId, 'projects');
    const q = query(projectsRef, orderBy('createdAt', 'asc'));
    const projectsSnapshot = await getDocs(q);
    const allProjects = projectsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    const archivedProjects = [];
    const batch = writeBatch(db);

    // Archive projects beyond the first one (Free plan allows 1 project)
    if (allProjects.length > 1) {
      for (let i = 1; i < allProjects.length; i++) {
        const projectRef = doc(projectsRef, allProjects[i].id);
        batch.update(projectRef, {
          archived: true,
          archivedAt: serverTimestamp(),
          archivedReason: 'Archived due to plan downgrade from Pro to Free',
          // Disable team collaboration features on archived projects
          allowSharing: false,
          allowTeamCollaboration: false,
          isCollaborative: false
        });
        archivedProjects.push({
          id: allProjects[i].id,
          title: allProjects[i].title || 'Untitled Project'
        });
      }
    }

    // Update user's plan to free in Firestore
    const userRef = doc(db, 'users', userId);
    batch.update(userRef, {
      plan: 'free',
      downgradedAt: serverTimestamp(),
      downgradeFrom: 'pro',
      archivedProjectsCount: archivedProjects.length
    });

    // Commit all changes in a single batch
    await batch.commit();

    return {
      success: true,
      newPlan: 'free',
      message: archivedProjects.length > 0 
        ? `Plan downgraded to Free. ${archivedProjects.length} project(s) archived.`
        : 'Plan downgraded to Free.',
      archivedProjects: archivedProjects
    };

  } catch (error) {
    console.error('Error handling plan downgrade:', error);
    throw new Error(`Failed to handle plan downgrade: ${error.message}`);
  }
}

// ============================================================
// --- Collaboration: Activity Feed, Role Update, Leave, Presence
// ============================================================

/**
 * Log an activity event to a project's activity subcollection.
 * @param {string} projectId - Project ID
 * @param {string} ownerId - Owner's user ID (for path)
 * @param {string} action - Short description e.g. "edited the shotlist"
 * @param {string} feature - Feature name e.g. "shotlist"
 */
export async function logProjectActivity(projectId, ownerId, action, feature = '') {
  const user = auth.currentUser;
  if (!user) return;
  try {
    // ownerId is the project owner's uid (may differ from current user for collaborators).
    // Only fall back to the current user's uid — never read from localStorage, which is
    // untrusted client-controlled storage.
    const ownerIdToUse = ownerId || user.uid;
    const activityRef = collection(db, 'users', ownerIdToUse, 'projects', projectId, 'activity');
    await addDoc(activityRef, {
      userId: user.uid,
      displayName: user.displayName || user.email || 'Someone',
      action,
      feature,
      timestamp: serverTimestamp()
    });
  } catch (e) {
    console.warn('Activity log failed (non-blocking):', e);
  }
}

/**
 * Listen to a project's activity feed in real time.
 * @param {string} projectId
 * @param {string} ownerId
 * @param {function} callback
 */
export function onActivitySnapshot(projectId, ownerId, callback) {
  // ownerId must come from a verified source (e.g. projectData.ownerId), not localStorage.
  const ownerIdToUse = ownerId || auth.currentUser?.uid;
  if (!ownerIdToUse) return () => {};
  const activityRef = collection(db, 'users', ownerIdToUse, 'projects', projectId, 'activity');
  const q = query(activityRef, orderBy('timestamp', 'desc'));
  return onSnapshot(q, (snap) => {
    const events = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    callback(events);
  });
}

/**
 * Update a collaborator's role on a project.
 * @param {string} projectId
 * @param {string} collaboratorUserId
 * @param {string} newRole - 'viewer' | 'editor'
 */
export async function updateCollaboratorRole(projectId, collaboratorUserId, newRole) {
  await enforceTeamCollaborationAccess();

  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error("No authenticated user.");

  const projectsRef = getProjectsCollectionRef();
  if (!projectsRef) throw new Error("Cannot access projects.");
  const projectRef = doc(projectsRef, projectId);
  const projectSnap = await getDoc(projectRef);
  if (!projectSnap.exists()) throw new Error("Project not found.");

  const collaborators = (projectSnap.data().collaborators || []).map(c =>
    c.userId === collaboratorUserId ? { ...c, role: newRole } : c
  );
  const collaboratorRoles = Object.fromEntries(collaborators.map(c => [c.userId, c.role]));
  await updateDoc(projectRef, {
    collaborators,
    collaboratorIds: collaborators.map(c => c.userId),
    collaboratorRoles
  });

  // Also update the role in the collaborator's collaboratedProjects entry
  const collaboratedRef = collection(db, 'users', collaboratorUserId, 'collaboratedProjects');
  const q = query(collaboratedRef, where('projectId', '==', projectId));
  const snap = await getDocs(q);
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.update(d.ref, { role: newRole }));
  await batch.commit();
}

/**
 * Update a collaborator's feature-level permissions on a project.
 * featurePermissions is an object like:
 *   { screenplay: true, breakdown: false, shotlist: true, ... }
 * A missing key defaults to true (allowed).
 * @param {string} projectId
 * @param {string} collaboratorUserId
 * @param {object} featurePermissions
 */
export async function updateCollaboratorPermissions(projectId, collaboratorUserId, featurePermissions) {
  await enforceTeamCollaborationAccess();

  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error("No authenticated user.");

  const projectsRef = getProjectsCollectionRef();
  if (!projectsRef) throw new Error("Cannot access projects.");
  const projectRef = doc(projectsRef, projectId);
  const projectSnap = await getDoc(projectRef);
  if (!projectSnap.exists()) throw new Error("Project not found.");

  const collaborators = (projectSnap.data().collaborators || []).map(c =>
    c.userId === collaboratorUserId ? { ...c, featurePermissions } : c
  );

  await updateDoc(projectRef, { collaborators });
}

/**
 * Leave a collaborated project (remove self from collaborators).
 * @param {string} projectId
 * @param {string} ownerId - The project owner's user ID
 */
export async function leaveProject(projectId, ownerId) {
  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error("No authenticated user.");

  // Remove self from project's collaborators array
  const projectRef = doc(db, 'users', ownerId, 'projects', projectId);
  const projectSnap = await getDoc(projectRef);
  if (projectSnap.exists()) {
    const collaborators = (projectSnap.data().collaborators || []).filter(
      c => c.userId !== currentUser.uid
    );
    const collaboratorRoles = Object.fromEntries(collaborators.map(c => [c.userId, c.role]));
    await updateDoc(projectRef, {
      collaborators,
      collaboratorIds: collaborators.map(c => c.userId),
      collaboratorRoles,
      isCollaborative: collaborators.length > 0
    });
  }

  // Remove from own collaboratedProjects
  const collaboratedRef = collection(db, 'users', currentUser.uid, 'collaboratedProjects');
  const q = query(collaboratedRef, where('projectId', '==', projectId));
  const snap = await getDocs(q);
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

/**
 * Get unseen collaboration count for notification badge.
 * Counts collaboratedProjects entries where seenAt is null.
 */
export async function getUnseenCollabCount() {
  const userId = auth.currentUser?.uid;
  if (!userId) return 0;
  try {
    const ref = collection(db, 'users', userId, 'collaboratedProjects');
    const q = query(ref, where('seen', '==', false));
    const snap = await getDocs(q);
    return snap.size;
  } catch (e) {
    return 0;
  }
}

/**
 * Mark all collaborated projects as seen (clears badge).
 */
export async function markCollabsSeen() {
  const userId = auth.currentUser?.uid;
  if (!userId) return;
  try {
    const ref = collection(db, 'users', userId, 'collaboratedProjects');
    const q = query(ref, where('seen', '==', false));
    const snap = await getDocs(q);
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.update(d.ref, { seen: true }));
    await batch.commit();
  } catch (e) {
    console.warn('markCollabsSeen failed:', e);
  }
}

/**
 * Get comments for a specific scene/item.
 * @param {string} projectId
 * @param {string} ownerId
 * @param {string} featureKey - e.g. 'scene_abc123'
 */
export function onFeatureCommentsSnapshot(projectId, ownerId, featureKey, callback) {
  const ownerIdToUse = ownerId || auth.currentUser?.uid;
  if (!ownerIdToUse) return () => {};
  const commentsRef = collection(db, 'users', ownerIdToUse, 'projects', projectId, 'comments');
  const q = query(commentsRef, where('featureKey', '==', featureKey), orderBy('createdAt', 'asc'));
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}




// --- Notification Operations ---

/**
 * Create a notification for a user.
 * Stored at: users/{userId}/notifications/{notifId}
 * @param {string} recipientId - User to notify
 * @param {object} notif - { type, title, body, icon, link, meta }
 */
export async function createNotification(recipientId, { type, title, body, icon = 'fa-bell', link = null, meta = {} }) {
  try {
    const notifRef = collection(db, 'users', recipientId, 'notifications');
    await addDoc(notifRef, {
      type,       // 'collab_invite' | 'collab_removed' | 'project_update' | 'system'
      title,
      body,
      icon,
      link,
      meta,
      read: false,
      createdAt: serverTimestamp()
    });
  } catch (e) {
    console.warn('createNotification failed (non-blocking):', e);
  }
}

/**
 * Listen to a user's notifications in real time.
 * Returns unsubscribe function.
 */
export function onNotificationsSnapshot(callback) {
  const userId = auth.currentUser?.uid;
  if (!userId) return () => {};
  const notifRef = collection(db, 'users', userId, 'notifications');
  const q = query(notifRef, orderBy('createdAt', 'desc'));
  return onSnapshot(q, (snap) => {
    const notifications = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    callback(notifications);
  }, (err) => {
    console.warn('onNotificationsSnapshot error:', err);
  });
}

/**
 * Mark a single notification as read.
 */
export async function markNotificationRead(notifId) {
  const userId = auth.currentUser?.uid;
  if (!userId) return;
  const notifRef = doc(db, 'users', userId, 'notifications', notifId);
  await updateDoc(notifRef, { read: true });
}

/**
 * Mark all notifications as read.
 */
export async function markAllNotificationsRead() {
  const userId = auth.currentUser?.uid;
  if (!userId) return;
  const notifRef = collection(db, 'users', userId, 'notifications');
  const q = query(notifRef, where('read', '==', false));
  const snap = await getDocs(q);
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.update(d.ref, { read: true }));
  await batch.commit();
}

/**
 * Delete a notification.
 */
export async function deleteNotification(notifId) {
  const userId = auth.currentUser?.uid;
  if (!userId) return;
  const notifRef = doc(db, 'users', userId, 'notifications', notifId);
  await deleteDoc(notifRef);
}

/**
 * Get unread notification count.
 */
export async function getUnreadNotificationCount() {
  const userId = auth.currentUser?.uid;
  if (!userId) return 0;
  try {
    const notifRef = collection(db, 'users', userId, 'notifications');
    const q = query(notifRef, where('read', '==', false));
    const snap = await getDocs(q);
    return snap.size;
  } catch (e) {
    return 0;
  }
}

// --- Media Library Operations ---

/**
 * Listen to the current user's media library in real-time.
 * Used by the MediaPicker component.
 * @param {function} callback - Called with the Firestore snapshot
 * @returns {function} Unsubscribe function
 */
export function onMediaSnapshot(callback) {
  const userId = auth.currentUser?.uid;
  if (!userId) {
    console.error("onMediaSnapshot: No authenticated user.");
    return () => {};
  }
  const mediaRef = collection(db, 'users', userId, 'media');
  const q = query(mediaRef, orderBy('createdAt', 'desc'));
  return onSnapshot(q, callback, (error) => {
    console.error("Media snapshot error:", error);
  });
}

/**
 * Add a media item to the current user's media library.
 * @param {object} mediaData - Media metadata (url, name, type, projectId, etc.)
 * @returns {Promise<DocumentReference>} The new document reference
 */
export function addMediaToLibrary(mediaData) {
  const userId = auth.currentUser?.uid;
  if (!userId) throw new Error("Cannot add media: No authenticated user.");
  const mediaRef = collection(db, 'users', userId, 'media');
  return addDoc(mediaRef, {
    ...mediaData,
    createdAt: serverTimestamp()
  });
}

/**
 * Update a media item in the current user's media library.
 * @param {string} mediaId - The media document ID
 * @param {object} newData - Fields to update
 */
export function updateMediaInLibrary(mediaId, newData) {
  const userId = auth.currentUser?.uid;
  if (!userId) throw new Error("Cannot update media: No authenticated user.");
  const mediaRef = doc(db, 'users', userId, 'media', mediaId);
  return updateDoc(mediaRef, newData);
}

/**
 * Delete a media item from the current user's media library.
 * @param {string} mediaId - The media document ID
 */
export function deleteMediaFromLibrary(mediaId) {
  const userId = auth.currentUser?.uid;
  if (!userId) throw new Error("Cannot delete media: No authenticated user.");
  const mediaRef = doc(db, 'users', userId, 'media', mediaId);
  return deleteDoc(mediaRef);
}

/**
 * Fetch a single media item by ID.
 * @param {string} mediaId - The media document ID
 * @returns {Promise<object|null>} Media data or null if not found
 */
export async function getMediaById(mediaId) {
  const userId = auth.currentUser?.uid;
  if (!userId) throw new Error("Cannot get media: No authenticated user.");
  const mediaRef = doc(db, 'users', userId, 'media', mediaId);
  const snap = await getDoc(mediaRef);
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// ============================================================
// Presence System
// ============================================================

/**
 * Set the current user's presence on a project page.
 * @param {string} projectId
 * @param {object} data - { feature, displayName, photoURL }
 */
export async function setUserPresence(projectId, ownerId, data = {}) {
  const user = auth.currentUser;
  if (!user || !projectId) return;
  const ownerIdToUse = ownerId || user.uid;
  const presenceRef = doc(
    db, 'users', ownerIdToUse, 'projects', projectId, 'presence', user.uid
  );
  await setDoc(presenceRef, {
    uid: user.uid,
    displayName: data.displayName || user.displayName || user.email || 'Someone',
    photoURL: data.photoURL || user.photoURL || null,
    feature: data.feature || 'viewing',
    lastSeen: serverTimestamp()
  }, { merge: true });
}

/**
 * Remove the current user's presence from a project page.
 * @param {string} projectId
 */
export async function removeUserPresence(projectId, ownerId) {
  const user = auth.currentUser;
  if (!user || !projectId) return;
  const ownerIdToUse = ownerId || user.uid;
  const presenceRef = doc(
    db, 'users', ownerIdToUse, 'projects', projectId, 'presence', user.uid
  );
  await deleteDoc(presenceRef).catch(() => {});
}

/**
 * Listen to all active users on a project in real time.
 * Filters out stale presence records (older than 2 minutes).
 * @param {string} projectId
 * @param {function} callback - Called with array of active user objects
 */
export function onProjectPresenceSnapshot(projectId, ownerId, callback) {
  const user = auth.currentUser;
  if (!user || !projectId) return () => {};
  const ownerIdToUse = ownerId || user.uid;
  const presenceRef = collection(
    db, 'users', ownerIdToUse, 'projects', projectId, 'presence'
  );
  return onSnapshot(presenceRef, (snap) => {
    const now = Date.now();
    const TWO_MINUTES = 2 * 60 * 1000;
    const activeUsers = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(u => {
        if (!u.lastSeen) return false;
        const lastSeen = u.lastSeen.toDate ? u.lastSeen.toDate() : new Date(u.lastSeen);
        return (now - lastSeen.getTime()) < TWO_MINUTES;
      });
    callback(activeUsers);
  }, (err) => {
    console.warn('Presence snapshot error:', err);
  });
}

// ============================================================
// Comments System
// ============================================================

function getCommentsRef(projectId, ownerId) {
  const ownerIdToUse = ownerId || auth.currentUser?.uid;
  if (!ownerIdToUse) return null;
  return collection(db, 'users', ownerIdToUse, 'projects', projectId, 'comments');
}

/**
 * Add a comment to a project.
 * @param {string} projectId
 * @param {string} ownerId
 * @param {object} commentData - { text, context, authorId, authorName, authorPhoto }
 */
export async function addComment(projectId, ownerId, commentData) {
  const commentsRef = getCommentsRef(projectId, ownerId);
  if (!commentsRef) throw new Error('Cannot add comment: no auth.');
  return addDoc(commentsRef, {
    ...commentData,
    replies: [],
    createdAt: serverTimestamp()
  });
}

/**
 * Add a reply to an existing comment.
 * @param {string} projectId
 * @param {string} ownerId
 * @param {string} commentId
 * @param {object} replyData - { text, authorId, authorName, authorPhoto }
 */
export async function addCommentReply(projectId, ownerId, commentId, replyData) {
  const commentsRef = getCommentsRef(projectId, ownerId);
  if (!commentsRef) throw new Error('Cannot add reply: no auth.');
  const commentRef = doc(commentsRef, commentId);
  const snap = await getDoc(commentRef);
  if (!snap.exists()) throw new Error('Comment not found.');
  const existing = snap.data().replies || [];
  return updateDoc(commentRef, {
    replies: [...existing, { ...replyData, createdAt: new Date().toISOString() }]
  });
}

/**
 * Delete a comment (only the author can delete).
 * @param {string} projectId
 * @param {string} ownerId
 * @param {string} commentId
 */
export async function deleteComment(projectId, ownerId, commentId) {
  const commentsRef = getCommentsRef(projectId, ownerId);
  if (!commentsRef) throw new Error('Cannot delete comment: no auth.');
  return deleteDoc(doc(commentsRef, commentId));
}

/**
 * Listen to all comments on a project in real time.
 * @param {string} projectId
 * @param {string} ownerId
 * @param {function} callback
 */
export function onCommentsSnapshot(projectId, ownerId, callback) {
  const commentsRef = getCommentsRef(projectId, ownerId);
  if (!commentsRef) return () => {};
  const q = query(commentsRef, orderBy('createdAt', 'desc'));
  return onSnapshot(q, (snap) => {
    const comments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    callback(comments);
  }, (err) => {
    console.warn('Comments snapshot error:', err);
  });
}

/**
 * Mark a notification as read.
 * @param {string} notificationId
 */
export async function markNotificationAsRead(notificationId) {
  const userId = auth.currentUser?.uid;
  if (!userId) return;
  const notifRef = doc(db, 'users', userId, 'notifications', notificationId);
  await updateDoc(notifRef, { read: true }).catch(() => {});
}

// ============================================================
// Project Share Link System
// ============================================================

/**
 * Generate a shareable invite link for a project.
 * Creates a token in Firestore under `projectInvites/{token}`.
 * The link format: https://prepapp.name.ng/dashboard.html?joinProject={token}
 *
 * @param {string} projectId - The project to share
 * @param {string} role - Default role for joiners: 'viewer' | 'editor'
 * @returns {Promise<string>} The full shareable URL
 */
export async function generateProjectShareLink(projectId, role = 'editor') {
  await enforceTeamCollaborationAccess();

  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error("No authenticated user.");

  // Get project name for display in the join flow
  const projectsRef = getProjectsCollectionRef();
  if (!projectsRef) throw new Error("Cannot access projects.");
  const projectSnap = await getDoc(doc(projectsRef, projectId));
  if (!projectSnap.exists()) throw new Error("Project not found.");
  const projectData = projectSnap.data();

  // Check if an active invite already exists for this project
  const invitesRef = collection(db, 'projectInvites');
  const existingQ = query(
    invitesRef,
    where('projectId', '==', projectId),
    where('ownerId', '==', currentUser.uid),
    where('active', '==', true)
  );
  const existingSnap = await getDocs(existingQ);
  if (!existingSnap.empty) {
    const token = existingSnap.docs[0].id;
    return `https://prepapp.name.ng/dashboard.html?joinProject=${token}`;
  }

  // Create a new invite token
  const inviteRef = await addDoc(invitesRef, {
    projectId,
    ownerId: currentUser.uid,
    ownerName: currentUser.displayName || currentUser.email,
    projectName: projectData.name || 'Untitled Project',
    role,
    active: true,
    createdAt: serverTimestamp()
  });

  return `https://prepapp.name.ng/dashboard.html?joinProject=${inviteRef.id}`;
}

/**
 * Join a project via a share link token.
 * Adds the current user as a collaborator on the owner's project.
 *
 * @param {string} token - The invite token from the URL
 * @returns {Promise<{success: boolean, message: string, projectId?: string, ownerId?: string}>}
 */
export async function joinProjectViaShareLink(token) {
  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error("No authenticated user.");

  // Fetch the invite document
  const inviteRef = doc(db, 'projectInvites', token);
  const inviteSnap = await getDoc(inviteRef);

  if (!inviteSnap.exists()) {
    return { success: false, message: 'This invite link is invalid or has expired.' };
  }

  const invite = inviteSnap.data();

  if (!invite.active) {
    return { success: false, message: 'This invite link has been deactivated.' };
  }

  const { projectId, ownerId, ownerName, projectName, role } = invite;

  // Can't join your own project
  if (ownerId === currentUser.uid) {
    return { success: false, message: "You already own this project.", projectId, ownerId };
  }

  // Check if already a collaborator
  const projectRef = doc(db, 'users', ownerId, 'projects', projectId);
  const projectSnap = await getDoc(projectRef);

  if (!projectSnap.exists()) {
    return { success: false, message: 'The project no longer exists.' };
  }

  const projectData = projectSnap.data();
  const collaborators = projectData.collaborators || [];

  if (collaborators.some(c => c.userId === currentUser.uid)) {
    // Already a collaborator — just redirect them
    return {
      success: true,
      alreadyMember: true,
      message: `You're already a collaborator on "${projectName}".`,
      projectId,
      ownerId
    };
  }

  // Add the current user as a collaborator
  const newCollaborator = {
    userId: currentUser.uid,
    email: currentUser.email,
    displayName: currentUser.displayName || currentUser.email,
    role: role || 'editor',
    addedAt: new Date().toISOString(),
    addedBy: ownerId,
    joinedViaLink: true
  };

  const updatedCollaborators = [...collaborators, newCollaborator];
  const collaboratorRoles = Object.fromEntries(updatedCollaborators.map(c => [c.userId, c.role]));

  await updateDoc(projectRef, {
    collaborators: updatedCollaborators,
    collaboratorIds: updatedCollaborators.map(c => c.userId),
    collaboratorRoles,
    isCollaborative: true
  });

  // Add entry to the joiner's collaboratedProjects
  const collaboratedRef = collection(db, 'users', currentUser.uid, 'collaboratedProjects');
  const entryRef = doc(collaboratedRef, projectId);
  const existingEntry = await getDoc(entryRef);
  if (!existingEntry.exists()) {
    await setDoc(entryRef, {
      projectId,
      ownerId,
      ownerEmail: '',
      ownerName: ownerName || 'Someone',
      projectName: projectData.name || projectName,
      role: role || 'editor',
      addedAt: serverTimestamp(),
      seen: false
    });
  }

  // Notify the project owner
  await createNotification(ownerId, {
    type: 'collab_joined',
    title: 'Someone joined your project',
    body: `${currentUser.displayName || currentUser.email} joined "${projectData.name}" via share link`,
    icon: 'fa-user-plus',
    link: `project_details.html?projectId=${projectId}`,
    meta: { projectId, userId: currentUser.uid }
  });

  return {
    success: true,
    message: `You've joined "${projectData.name || projectName}" as a ${role || 'editor'}.`,
    projectId,
    ownerId
  };
}

/**
 * Deactivate a project's share link (revoke all future joins).
 * @param {string} projectId
 */
export async function revokeProjectShareLink(projectId) {
  await enforceTeamCollaborationAccess();

  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error("No authenticated user.");

  const invitesRef = collection(db, 'projectInvites');
  const q = query(
    invitesRef,
    where('projectId', '==', projectId),
    where('ownerId', '==', currentUser.uid),
    where('active', '==', true)
  );
  const snap = await getDocs(q);
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.update(d.ref, { active: false }));
  await batch.commit();
}

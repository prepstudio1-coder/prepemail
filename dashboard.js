import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";
import {
  onProfileSnapshot,
  onProjectsSnapshot,
  addProject,
  updateProject,
  deleteProject,
  logAnalyticsEvent 
} from "./firebase-operations.js";

// Default avatar fallback (SVG data URI)
const DEFAULT_AVATAR = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 60 60%22%3E%3Crect fill=%22%23e0e0e0%22 width=%2260%22 height=%2260%22/%3E%3Ccircle cx=%2230%22 cy=%2220%22 r=%2210%22 fill=%22%23999%22/%3E%3Cpath d=%22M10 45 Q30 35 50 45 L50 60 L10 60 Z%22 fill=%22%23999%22/%3E%3C/svg%3E';

// --- 1. IMMEDIATE LOAD & SERVICE WORKER ---
document.addEventListener("DOMContentLoaded", () => {
  const isDark = localStorage.getItem("darkMode") === "on";
  if (isDark) document.body.classList.add("dark");

  // A/B Testing: Randomly assign variant for feature box styling
  const abVariant = localStorage.getItem('abVariant') || (Math.random() < 0.5 ? 'A' : 'B');
  localStorage.setItem('abVariant', abVariant);
  if (abVariant === 'B') {
    const featureBoxes = document.querySelectorAll('.feature-box');
    featureBoxes.forEach(box => {
      box.style.borderLeftColor = 'var(--color-primary)';
      box.style.boxShadow = '0 4px 12px rgba(0, 123, 255, 0.3)';
    });
  }
  // Log the variant for analytics
  logAnalyticsEvent('ab_test_variant', { variant: abVariant });

  initializeLoadingStates();
  loadCachedData();
  initializeCategoryTabs();
  initializeJoinWaitlist();
  initializeTour();
  attachTourEventListeners();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then((reg) => console.log('SW registered:', reg.scope))
        .catch((err) => console.error('SW failed:', err));
    });
  }
});

// DOM References
const projectListDiv = document.getElementById("projectList");
const projectEditDeleteModal = document.getElementById('projectEditDeleteModal');
const editProjectInput = document.getElementById('editProjectInput');
const saveEditBtn = document.getElementById('saveEditBtn');
const deleteProjectBtn = document.getElementById('deleteProjectBtn');
const cancelModalBtn = document.getElementById('cancelModalBtn');
const createProjectBtn = document.getElementById('createProjectBtn');
const createProjectModal = document.getElementById('createProjectModal');
const newProjectNameInput = document.getElementById('newProjectNameInput');
const createProjectNameStep = document.getElementById('createProjectNameStep');
const createProjectOptions = document.getElementById('createProjectOptions');
const uploadScriptBtn = document.getElementById('uploadScriptBtn');
const startAiScriptBtn = document.getElementById('startAiScriptBtn');
const backToNameBtn = document.getElementById('backToNameBtn');
const projectScriptFileInput = document.getElementById('projectScriptFileInput');
const createConfirmBtn = document.getElementById('createConfirmBtn');
const cancelCreateBtn = document.getElementById('cancelCreateBtn');
const shotlistFeatureBox = document.getElementById('shotlistFeatureBox');
const shotlistEntryModal = document.getElementById('shotlistEntryModal');
const createNewShotlistProjectBtn = document.getElementById('createNewShotlistProjectBtn');

// Welcome Guide Modal
const welcomeGuideModal = document.getElementById('welcomeGuideModal');
const startCreatingBtn = document.getElementById('startCreatingBtn');
const viewGuideBtn = document.getElementById('viewGuideBtn');
const viewExistingShotlistProjectsBtn = document.getElementById('viewExistingShotlistProjectsBtn');
const cancelShotlistEntryBtn = document.getElementById('cancelShotlistEntryBtn');
const projectSelectionList = document.getElementById('projectSelectionList');
const selectableProjectsContainer = document.getElementById('selectableProjectsContainer');
const noSelectableProjectsMessage = document.getElementById('noSelectableProjectsMessage');
const projectSearchInput = document.getElementById('projectSearchInput');
let confirmationModal = document.getElementById('confirmationModal');
let confirmationMessage = document.getElementById('confirmationMessage');
let confirmOkBtn = document.getElementById('confirmOkBtn');
let confirmCancelBtn = document.getElementById('confirmCancelBtn');
const profileLoading = document.getElementById('profileLoading');
const profileContent = document.getElementById('profileContent');
const profileImage = document.getElementById('profileImage');
const greetingText = document.getElementById('greetingText');
const userMenuBtn = document.getElementById('userMenuBtn');
const userMenuDropdown = document.getElementById('userMenuDropdown');
const logoutItem = document.getElementById('logoutItem');
const themeToggleItem = document.getElementById('themeToggleItem');
const themeLabel = document.getElementById('themeLabel');
const themeIcon = document.querySelector('.theme-icon');
const shareProfileItem = document.getElementById('shareProfileItem');
const shareProfileModal = document.getElementById('shareProfileModal');
const closeShareModal = document.getElementById('closeShareModal');
const shareCardButton = document.getElementById('shareCardButton');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const featureRequestItem = document.getElementById('featureRequestItem');
const featureRequestModal = document.getElementById('featureRequestModal');
const closeFeatureModal = document.getElementById('closeFeatureModal');
const featureRequestForm = document.getElementById('featureRequestForm');
const submitFeatureBtn = document.getElementById('submitFeatureBtn');
const cancelFeatureBtn = document.getElementById('cancelFeatureBtn');
const screenplayFeatureBox = document.getElementById('screenplayFeatureBox');
const storyboardFeatureBox = document.getElementById('storyboardFeatureBox');
const breakdownFeatureBox = document.getElementById('breakdownFeatureBox');
const shootDaysFeatureBox = document.getElementById('shootDaysFeatureBox');
const scriptItFeatureBox = document.getElementById('scriptItFeatureBox');
const castAndCrewFeatureBox = document.getElementById('castAndCrewFeatureBox');
const noProjectsMessage = document.getElementById('noProjectsMessage');
const toastMessage = document.getElementById('toastMessage');
const projectsLoading = document.getElementById('projectsLoading');
const aiScriptFeatureBox = document.getElementById('aiScriptFeatureBox');

function getUrlParam(name) {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get(name);
}

// State
let projects = [];
let projectsUnsubscribe = null;
let creatingFromShotlistFeature = false;
let currentProjectBox = null;
const RECENT_PROJECTS_LIMIT = 5;
let pressTimer;
let isLongPressDetected = false;
const LONG_PRESS_THRESHOLD = 700;
let targetFeatureUrl = 'scenes.html';

// --- 2. CACHING ---
function loadCachedData() {
  const cachedProfile = localStorage.getItem('prep_user_profile');
  if (cachedProfile) {
    try {
      const profileData = JSON.parse(cachedProfile);
      updateProfileDisplay(profileData);
      hideProfileLoading();
    } catch (e) { console.error("Cache error", e); }
  }

  const cachedProjects = localStorage.getItem('prep_user_projects');
  if (cachedProjects) {
    try {
      projects = JSON.parse(cachedProjects);
      renderProjects();
      hideProjectsLoading();
    } catch (e) { console.error("Cache error", e); }
  }
}

// Show projects loading on first load if no cache
function initializeLoadingStates() {
  const hasProfileCache = localStorage.getItem('prep_user_profile');
  const hasProjectsCache = localStorage.getItem('prep_user_projects');
  
  if (!hasProfileCache) showProfileLoading();
  if (!hasProjectsCache) showProjectsLoading();
}

// --- 3. AUTH & INIT ---
onAuthStateChanged(auth, (user) => {
  if (user) {
    console.log("User authenticated:", user.email);
    logAnalyticsEvent('session_start');
    window.addEventListener('beforeunload', () => logAnalyticsEvent('session_end'));
    initializeDashboard(user);
  } else {
    console.log("User not authenticated, redirecting to login");
    window.location.href = "login.html";
  }
});

function initializeDashboard(user) {
  if (!user || !user.uid) {
    console.error("Invalid user object");
    window.location.href = "login.html";
    return;
  }

  if (projects.length === 0) showProjectsLoading();
  const cachedProfile = localStorage.getItem('prep_user_profile');
  if (!cachedProfile) showProfileLoading();

  const userRef = doc(db, 'users', user.uid);
  
  onSnapshot(userRef, (doc) => {
      if (doc.exists()) {
          const userData = doc.data();
          localStorage.setItem('prep_user_profile', JSON.stringify(userData));
          updateProfileDisplay(userData);
      } else {
          updateProfileDisplay({ fullName: "User", image: DEFAULT_AVATAR });
      }
      hideProfileLoading();
  }, (error) => {
      console.warn("Profile sync error:", error.message);
      // Use cached profile on error
      const cachedProfile = localStorage.getItem('prep_user_profile');
      if (cachedProfile) {
        try {
          const profileData = JSON.parse(cachedProfile);
          updateProfileDisplay(profileData);
        } catch (e) {
          updateProfileDisplay({ fullName: "User", image: DEFAULT_AVATAR });
        }
      }
      hideProfileLoading();
  });

  subscribeToProjects();
  renderProjects(); // Ensure no-projects message shows if no projects
  attachEventListeners();
  
  // Fallback to hide loading after 10 seconds in case snapshots don't fire
  setTimeout(() => {
    hideProfileLoading();
    hideProjectsLoading();
  }, 10000);
  
  // Initialize tour system
  setTimeout(() => initializeTour(), 500);

  if (getUrlParam('new') === '1') {
    showCreateProjectModal();
    window.history.replaceState({}, document.title, window.location.pathname);
  } else if (projects.length === 0 && !localStorage.getItem('welcomeGuideShown')) {
    // Simple, reliable tour trigger for new users
    setTimeout(() => showTour(), 2000);
  }
}

function subscribeToProjects() {
  if (projectsUnsubscribe) projectsUnsubscribe();
  showProjectsLoading();
  projectsUnsubscribe = onProjectsSnapshot((querySnapshot) => {
    const newProjects = [];
    querySnapshot.forEach((doc) => {
      newProjects.push({ id: doc.id, ...doc.data() });
    });
    projects = newProjects;
    localStorage.setItem('prep_user_projects', JSON.stringify(projects));
    renderProjects();
    hideProjectsLoading();
  }, (error) => {
    console.warn("Projects sync error:", error.message);
    hideProjectsLoading();
    
    // Ensure user sees something even on error
    if (projects.length === 0) {
      noProjectsMessage.style.display = 'flex';
      projectListDiv.style.display = 'none';
      if (projectsLoading) projectsLoading.style.display = 'none';
    }
    
    // Show error toast for network issues
    if (error.code === 'permission-denied') {
      showToast("You don't have permission to load projects", 'error');
    } else if (navigator.onLine === false) {
      showToast("You're offline. Showing cached data.", 'info');
    }
  });
}

function updateProfileDisplay(profileData) {
  if (profileImage) {
    profileImage.src = profileData.image || DEFAULT_AVATAR;
    // Prevent infinite error loop - only set fallback once
    profileImage.onerror = () => { 
      if (profileImage.src !== DEFAULT_AVATAR) {
        profileImage.src = DEFAULT_AVATAR;
      }
      profileImage.onerror = null; // Remove error handler after fallback
    };
  }
  
  // Time-based greeting logic
  if (greetingText) {
    const hour = new Date().getHours();
    let timeGreeting = "Hello";
    if (hour < 12) timeGreeting = "Good Morning";
    else if (hour < 18) timeGreeting = "Good Afternoon";
    else timeGreeting = "Good Evening";

    // Display user's role (jobTitle) or fallback to displayName
    const userRole = profileData.jobTitle || profileData.displayName || 'Creative';

    // Set innerHTML to style the greeting smaller than the name
    greetingText.innerHTML = `
      <span style="font-weight:400; font-size: 0.85em; opacity: 0.8;">${timeGreeting},</span><br>
      ${userRole}
    `;
    greetingText.style.display = 'block';
  }
}

// Loading States
const showProjectsLoading = () => { 
  if (projectsLoading) {
    projectsLoading.style.display = 'grid';
    projectListDiv.style.display = 'none';
  }
};

const hideProjectsLoading = () => { 
  if (projectsLoading) {
    projectsLoading.style.display = 'none';
  }
};
const showProfileLoading = () => {
  if (profileLoading) profileLoading.style.display = 'flex';
  if (profileContent) profileContent.style.display = 'none';
};
const hideProfileLoading = () => {
  if (profileLoading) profileLoading.style.display = 'none';
  if (profileContent) profileContent.style.display = 'flex';
};

// Improved Toast with Type Support
const showToast = (message, type = 'info') => {
    if (!toastMessage) return;
    toastMessage.textContent = message;
    toastMessage.classList.add('show');
    
    // Color based on type
    if (type === 'success') {
        toastMessage.style.background = '#28a745';
    } else if (type === 'error') {
        toastMessage.style.background = '#dc3545';
    } else {
        toastMessage.style.background = '#333';
    }
    
    setTimeout(() => { 
        toastMessage.classList.remove('show');
        toastMessage.style.background = '#333'; // Reset
    }, 3000);
};

// Update Theme Icon Based on Current Mode
function updateThemeIcon() {
  const isDark = localStorage.getItem('darkMode') === 'on';
  const icon = document.querySelector('.theme-icon');
  const label = document.getElementById('themeLabel');
  
  if (icon) {
    if (isDark) {
      icon.classList.remove('fa-moon', 'moon');
      icon.classList.add('fa-sun', 'sun');
      if (label) label.textContent = 'Light Mode';
    } else {
      icon.classList.remove('fa-sun', 'sun');
      icon.classList.add('fa-moon', 'moon');
      if (label) label.textContent = 'Dark Mode';
    }
  }
}

// Feature Request Validation
function validateFeatureForm() {
  clearFormErrors();
  let isValid = true;

  const title = document.getElementById('featureTitle').value.trim();
  const category = document.getElementById('featureCategory').value;
  const description = document.getElementById('featureDescription').value.trim();

  if (!title) {
    showFieldError('featureTitleError', 'Feature title is required.');
    isValid = false;
  } else if (title.length < 5) {
    showFieldError('featureTitleError', 'Title must be at least 5 characters.');
    isValid = false;
  }

  if (!category) {
    showFieldError('featureCategoryError', 'Please select a category.');
    isValid = false;
  }

  if (!description) {
    showFieldError('featureDescriptionError', 'Description is required.');
    isValid = false;
  } else if (description.length < 10) {
    showFieldError('featureDescriptionError', 'Description must be at least 10 characters.');
    isValid = false;
  }

  return isValid;
}

function showFieldError(fieldId, message) {
  const errorElement = document.getElementById(fieldId);
  if (errorElement) {
    errorElement.textContent = message;
    errorElement.classList.add('show');
  }
}

function clearFormErrors() {
  const errorElements = featureRequestForm.querySelectorAll('.error-message');
  errorElements.forEach(el => {
    el.textContent = '';
    el.classList.remove('show');
  });
}

// Event Listeners
function attachEventListeners() {

  // User Menu Dropdown Handler
  if (userMenuBtn) {
    userMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      userMenuDropdown.classList.toggle('show');
      userMenuBtn.classList.toggle('active');
    });
  }

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.user-menu-container')) {
      userMenuDropdown.classList.remove('show');
      if (userMenuBtn) userMenuBtn.classList.remove('active');
    }
  });

  // Theme Toggle
  if (themeToggleItem) {
    themeToggleItem.addEventListener('click', () => {
      const isDark = localStorage.getItem('darkMode') === 'on';
      const newMode = isDark ? 'off' : 'on';
      localStorage.setItem('darkMode', newMode);
      
      if (newMode === 'on') {
        document.body.classList.add('dark');
        if (themeLabel) themeLabel.textContent = 'Light Mode';
        if (themeIcon) {
          themeIcon.classList.remove('fa-moon', 'moon');
          themeIcon.classList.add('fa-sun', 'sun');
        }
      } else {
        document.body.classList.remove('dark');
        if (themeLabel) themeLabel.textContent = 'Dark Mode';
        if (themeIcon) {
          themeIcon.classList.remove('fa-sun', 'sun');
          themeIcon.classList.add('fa-moon', 'moon');
        }
      }
      
      userMenuDropdown.classList.remove('show');
      if (userMenuBtn) userMenuBtn.classList.remove('active');
      showToast(newMode === 'on' ? 'Dark mode enabled' : 'Light mode enabled', 'success');
    });
  }

  // Share Profile
  if (shareProfileItem) {
    shareProfileItem.addEventListener('click', async () => {
      const profileData = localStorage.getItem('prep_user_profile');
      if (!profileData) {
        showToast('Profile data not available', 'error');
        return;
      }

      const profile = JSON.parse(profileData);
      
      // Populate card
      document.getElementById('shareCardImage').src = profile.image || DEFAULT_AVATAR;
      document.getElementById('shareCardImage').onerror = () => {
        document.getElementById('shareCardImage').src = DEFAULT_AVATAR;
      };
      document.getElementById('shareCardName').textContent = profile.fullName || profile.displayName || 'User';
      document.getElementById('shareCardRole').textContent = profile.jobTitle || 'Professional';
      document.getElementById('shareCardLocation').textContent = profile.location || '—';
      document.getElementById('shareCardExperience').textContent = profile.experience || '—';
      document.getElementById('shareCardBio').textContent = profile.bio || 'No biography provided.';

      const profileLink = `${window.location.origin}/public-profile.html?uid=${auth.currentUser.uid}`;
      document.getElementById('shareCardLink').value = profileLink;

      // Show modal
      shareProfileModal.style.display = 'flex';
      userMenuDropdown.classList.remove('show');
      if (userMenuBtn) userMenuBtn.classList.remove('active');
    });
  }

  // Close modal
  if (closeShareModal) {
    closeShareModal.addEventListener('click', () => {
      shareProfileModal.style.display = 'none';
    });
  }

  // Share button in card
  if (shareCardButton) {
    shareCardButton.addEventListener('click', async () => {
      const profileLink = document.getElementById('shareCardLink').value;
      const profileName = document.getElementById('shareCardName').textContent;
      const profileRole = document.getElementById('shareCardRole').textContent;
      
      const shareText = `Check out my professional profile on PREP!\n\nName: ${profileName}\nRole: ${profileRole}\n\nView my profile: ${profileLink}`;

      try {
        if (navigator.share) {
          await navigator.share({
            title: 'My PREP Profile',
            text: shareText,
            url: profileLink
          });
        } else {
          await navigator.clipboard.writeText(profileLink);
          showToast('Profile link copied to clipboard!', 'success');
        }
      } catch (error) {
        if (error.name !== 'AbortError') {
          try {
            await navigator.clipboard.writeText(profileLink);
            showToast('Profile link copied to clipboard!', 'success');
          } catch (clipboardError) {
            showToast('Could not share profile', 'error');
          }
        }
      }
    });
  }

  // Copy link button
  if (copyLinkBtn) {
    copyLinkBtn.addEventListener('click', async () => {
      const link = document.getElementById('shareCardLink').value;
      try {
        await navigator.clipboard.writeText(link);
        showToast('Link copied to clipboard!', 'success');
        copyLinkBtn.innerHTML = '<i class="fas fa-check"></i>';
        setTimeout(() => {
          copyLinkBtn.innerHTML = '<i class="fas fa-copy"></i>';
        }, 2000);
      } catch (error) {
        showToast('Could not copy link', 'error');
      }
    });
  }

  // Close modal when clicking outside
  shareProfileModal?.addEventListener('click', (e) => {
    if (e.target === shareProfileModal) {
      shareProfileModal.style.display = 'none';
    }
  });

  // Feature Request
  if (featureRequestItem) {
    featureRequestItem.addEventListener('click', () => {
      featureRequestModal.style.display = 'flex';
      userMenuDropdown.classList.remove('show');
      if (userMenuBtn) userMenuBtn.classList.remove('active');
      featureRequestForm.reset();
      clearFormErrors();
    });
  }

  // Upgrade to Pro
  const upgradeProItem = document.getElementById('upgradeProItem');
  if (upgradeProItem) {
    upgradeProItem.addEventListener('click', () => {
      userMenuDropdown.classList.remove('show');
      if (userMenuBtn) userMenuBtn.classList.remove('active');
      window.location.href = 'pricing.html';
    });
  }

  if (closeFeatureModal) {
    closeFeatureModal.addEventListener('click', () => {
      featureRequestModal.style.display = 'none';
    });
  }

  if (cancelFeatureBtn) {
    cancelFeatureBtn.addEventListener('click', () => {
      featureRequestModal.style.display = 'none';
    });
  }

  featureRequestModal?.addEventListener('click', (e) => {
    if (e.target === featureRequestModal) {
      featureRequestModal.style.display = 'none';
    }
  });

  if (featureRequestForm) {
    featureRequestForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      if (!validateFeatureForm()) return;

      submitFeatureBtn.disabled = true;
      document.getElementById('submitFeatureBtnText').style.display = 'none';
      document.getElementById('submitFeatureSpinner').style.display = 'flex';

      const featureData = {
        uid: auth.currentUser.uid,
        email: auth.currentUser.email,
        title: document.getElementById('featureTitle').value.trim(),
        category: document.getElementById('featureCategory').value,
        description: document.getElementById('featureDescription').value.trim(),
        useCase: document.getElementById('featureUseCase').value.trim(),
        createdAt: new Date().toISOString(),
        status: 'new'
      };

      try {
        // Send feature request email
        const response = await fetch('https://prepemail.onrender.com/api/send-feature-request', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(featureData)
        });

        const result = await response.json();

        if (result.success) {
          showToast('Thank you! Your feature request has been submitted.', 'success');
          featureRequestModal.style.display = 'none';
          featureRequestForm.reset();
        } else {
          showToast('Error submitting feature request. Please try again.', 'error');
        }
      } catch (error) {
        console.error('Error submitting feature request:', error);
        showToast('Error submitting feature request. Please try again.', 'error');
      } finally {
        submitFeatureBtn.disabled = false;
        document.getElementById('submitFeatureBtnText').style.display = 'inline';
        document.getElementById('submitFeatureSpinner').style.display = 'none';
      }
    });
  }

  // Logout
  if (logoutItem) {
    logoutItem.addEventListener('click', () => {
      userMenuDropdown.classList.remove('show');
      if (userMenuBtn) userMenuBtn.classList.remove('active');
      
      showConfirmationModal('Are you sure you want to log out?', () => {
        auth.signOut().then(() => {
          localStorage.clear(); // Clear all app data
          window.location.href = 'index.html';
        }).catch((error) => {
          console.error('Error signing out:', error);
          showToast('Error logging out. Please try again.', 'error');
        });
      });
    });
  }

  // Initialize theme icon based on current mode
  updateThemeIcon();

  if (createProjectBtn) {
    createProjectBtn.addEventListener('click', () => {
      creatingFromShotlistFeature = false;
      localStorage.setItem('currentSceneArrayType', 'scenes_general');
      showCreateProjectModal();
    });
  }

  if (newProjectNameInput) {
    newProjectNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        createConfirmBtn?.click();
      }
    });
  }

  if (editProjectInput) {
    editProjectInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveEditBtn?.click();
      }
    });
  }

  if (createConfirmBtn) {
    createConfirmBtn.addEventListener('click', async () => {
      const newProjectName = newProjectNameInput.value.trim();
      if (!newProjectName) return showToast("Name cannot be empty.");
      if (projects.some(p => p.name === newProjectName)) return showToast("Name already exists.");

      // Preserve existing shotlist behavior
      if (creatingFromShotlistFeature) {
        const newProject = {
          name: newProjectName, createdAt: new Date().toISOString(),
          scenes_general: [], scenes_storyboard: [], scenes_breakdown: [], scenes_scriptit: []
        };
        try {
          const docRef = await addProject(newProject);
          localStorage.setItem('currentProjectId', docRef.id);
          localStorage.setItem('currentProjectName', newProjectName);
          window.location.href = targetFeatureUrl;
        } catch (e) {
          showToast("Error creating project.");
          console.error(e);
        }
        return;
      }

      // Offer user a choice: upload a script or start in AI Scribe
      showCreateProjectOptions();
    });
  }

  if (backToNameBtn) backToNameBtn.addEventListener('click', showCreateProjectNameStep);
  if (startAiScriptBtn) startAiScriptBtn.addEventListener('click', () => {
    const newProjectName = newProjectNameInput.value.trim();
    if (!newProjectName) return showToast("Name cannot be empty.");
    if (projects.some(p => p.name === newProjectName)) return showToast("Name already exists.");
    createProjectAndGoToAiScribe(newProjectName);
  });
  if (uploadScriptBtn) uploadScriptBtn.addEventListener('click', () => {
    const newProjectName = newProjectNameInput.value.trim();
    if (!newProjectName) return showToast("Name cannot be empty.");
    if (projects.some(p => p.name === newProjectName)) return showToast("Name already exists.");
    if (projectScriptFileInput) projectScriptFileInput.click();
  });
  if (projectScriptFileInput) {
    projectScriptFileInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (loadEvent) => {
        const content = String(loadEvent.target.result || "");
        const newProjectName = newProjectNameInput.value.trim();

        // Pass content directly to function - it handles localStorage
        await createProjectAndGoToAiScribe(newProjectName, content);
      };
      reader.readAsText(file);

      // Reset for next time
      projectScriptFileInput.value = "";
    });
  }


  if (cancelCreateBtn) cancelCreateBtn.addEventListener('click', closeCreateProjectModal);

  // Handle "Create Project" button from no-projects message
  const noProjectsCreateBtn = document.getElementById('noProjectsCreateBtn');
  if (noProjectsCreateBtn) {
    noProjectsCreateBtn.addEventListener('click', () => {
      console.log('Opening create project modal from no-projects message');
      showCreateProjectModal();
    });
  }

  if (saveEditBtn) {
    saveEditBtn.addEventListener('click', async () => {
      if (!currentProjectBox) return;
      const updatedName = editProjectInput.value.trim();
      const projectId = currentProjectBox.dataset.projectId;
      if (!updatedName) return showToast("Name cannot be empty.");
      
      try {
        await updateProject(projectId, { name: updatedName });
        showToast("Project updated");
        closeProjectEditDeleteModal();
      } catch (e) { console.error(e); showToast("Update failed"); }
    });
  }

  if (deleteProjectBtn) {
    deleteProjectBtn.addEventListener('click', () => {
      if (!currentProjectBox) return;
      const name = currentProjectBox.dataset.projectName;
      const id = currentProjectBox.dataset.projectId;
      showConfirmationModal(`Delete "${name}"?`, async () => {
        try {
          await deleteProject(id);
          showToast("Project deleted");
          closeProjectEditDeleteModal();
          if (localStorage.getItem('currentProjectId') === id) {
            localStorage.removeItem('currentProjectId');
            localStorage.removeItem('currentProjectName');
          }
        } catch (e) { console.error(e); showToast("Delete failed"); }
      });
    });
  }

  if (cancelModalBtn) cancelModalBtn.addEventListener('click', closeProjectEditDeleteModal);
  
  window.addEventListener('click', (e) => {
    if (e.target === createProjectModal) closeCreateProjectModal();
    if (e.target === projectEditDeleteModal) closeProjectEditDeleteModal();
    if (e.target === shotlistEntryModal) closeShotlistEntryModal();
    if (e.target === confirmationModal) confirmationModal.style.display = 'none';
  });

  if (projectSearchInput) {
    projectSearchInput.addEventListener('input', (e) => renderSelectableProjects(e.target.value));
  }

  // Feature Boxes
  if (screenplayFeatureBox) screenplayFeatureBox.addEventListener('click', () => showShotlistEntryModal('screenplay'));
  if (storyboardFeatureBox) storyboardFeatureBox.addEventListener('click', () => showShotlistEntryModal('storyboard'));
  if (breakdownFeatureBox) breakdownFeatureBox.addEventListener('click', () => showShotlistEntryModal('breakdown'));
  if (shootDaysFeatureBox) shootDaysFeatureBox.addEventListener('click', () => showShotlistEntryModal('shootdays'));
  if (scriptItFeatureBox) scriptItFeatureBox.addEventListener('click', () => showShotlistEntryModal('scriptit'));
  if (castAndCrewFeatureBox) castAndCrewFeatureBox.addEventListener('click', () => showShotlistEntryModal('cast'));
  if (shotlistFeatureBox) shotlistFeatureBox.addEventListener('click', () => showShotlistEntryModal('shotlist'));
  
  if (aiScriptFeatureBox) {
      aiScriptFeatureBox.addEventListener('click', () => {
          // You can add logic here to check if user is premium if needed
          window.location.href = "ai_script.html";
      });
  }

  if (cancelShotlistEntryBtn) cancelShotlistEntryBtn.addEventListener('click', closeShotlistEntryModal);

  if (createNewShotlistProjectBtn) {
    createNewShotlistProjectBtn.addEventListener('click', () => {
      creatingFromShotlistFeature = true;
      closeShotlistEntryModal();
      showCreateProjectModal();
    });
  }
  
  if (viewExistingShotlistProjectsBtn) {
    viewExistingShotlistProjectsBtn.addEventListener('click', () => {
      projectSelectionList.style.display = 'block';
      createNewShotlistProjectBtn.style.display = 'none';
      viewExistingShotlistProjectsBtn.style.display = 'none';
      projectSearchInput.style.display = 'block';
      projectSearchInput.focus();
      renderSelectableProjects();
    });
  }
}

function showConfirmationModal(message, onConfirm) {
  confirmationMessage.textContent = message;
  confirmationModal.style.display = 'flex';
  
  const newOkBtn = confirmOkBtn.cloneNode(true);
  confirmOkBtn.parentNode.replaceChild(newOkBtn, confirmOkBtn);
  confirmOkBtn = newOkBtn;

  const newCancelBtn = confirmCancelBtn.cloneNode(true);
  confirmCancelBtn.parentNode.replaceChild(newCancelBtn, confirmCancelBtn);
  confirmCancelBtn = newCancelBtn;

  confirmOkBtn.addEventListener('click', () => { onConfirm(); confirmationModal.style.display = 'none'; });
  confirmCancelBtn.addEventListener('click', () => { confirmationModal.style.display = 'none'; });
}

// --- RENDER HELPERS ---
// Script badge removed per request (cleaner card display)
function getProjectScriptBadge(project) {
  return '';
}

// --- RENDER LOGIC ---
const renderProjects = () => {
  if (!projectListDiv || !noProjectsMessage) return;

  projectListDiv.innerHTML = '';

  if (projects.length === 0) {
    noProjectsMessage.style.display = 'flex';
    projectListDiv.style.display = 'none';
  } else {
    noProjectsMessage.style.display = 'none';
    projectListDiv.style.display = 'grid';

    projects.slice(0, RECENT_PROJECTS_LIMIT).forEach((project, index) => {
      const projectBox = document.createElement('div');
      projectBox.className = 'project-box animate-in';
      projectBox.style.animationDelay = `${index * 0.1}s`;

      projectBox.dataset.projectId = project.id;
      projectBox.dataset.projectName = project.name;

      const metadataItems = [
        project.client ? `<span class="meta-badge meta-client"><strong>Client:</strong> ${project.client}</span>` : '',
        project.genre ? `<span class="meta-badge meta-genre"><strong>Genre:</strong> ${project.genre}</span>` : '',
        project.director ? `<span class="meta-badge meta-director"><strong>Director:</strong> ${project.director}</span>` : ''
      ].filter(Boolean);

      projectBox.innerHTML = `
        <div class="project-card-header">
          <div class="project-info">
            <h4>${project.name || 'Untitled Project'}</h4>
            ${metadataItems.length > 0 ? `<div class="project-meta-badges">${metadataItems.join('')}</div>` : ''}
          </div>
          <span class="project-date">
            <i class="fa-regular fa-calendar"></i>
            ${project.createdAt ? new Date(project.createdAt).toLocaleDateString() : 'No date'}
          </span>
        </div>
      `;
      projectListDiv.appendChild(projectBox);
    });

    // Attach click listeners to the newly rendered project boxes
    attachProjectBoxListeners();
  }
};

function attachProjectBoxListeners() {
  document.querySelectorAll('.project-box').forEach(box => {
    // 1. Normal Click (Open Project)
    box.addEventListener('click', () => {
      const projectId = box.dataset.projectId;
      window.location.href = `project_details.html?projectId=${projectId}`;
    });

    // 3. Long Press (Mobile Legacy Support - Optional but good for users used to it)
    ['mousedown', 'touchstart'].forEach(type => box.addEventListener(type, handlePressStart, { passive: type === 'touchstart' }));
    ['mouseup', 'touchend', 'mouseleave', 'touchcancel'].forEach(type => box.addEventListener(type, handlePressEnd));
  });
}

function handlePressStart(event) {
  // If clicking the button, ignore long press logic
  if (event.target.closest('.project-options-btn')) return;

  const box = event.currentTarget;
  isLongPressDetected = false;
  pressTimer = setTimeout(() => {
    isLongPressDetected = true;
    showProjectEditDeleteModal(box);
  }, LONG_PRESS_THRESHOLD);
}

function handlePressEnd(event) {
  clearTimeout(pressTimer);
  // Navigation is now handled by the 'click' listener above to avoid conflicts
}

function showProjectEditDeleteModal(box) {
  currentProjectBox = box;
  if (editProjectInput) editProjectInput.value = box.dataset.projectName;
  if (projectEditDeleteModal) projectEditDeleteModal.style.display = 'flex';
}

function closeProjectEditDeleteModal() {
  if (projectEditDeleteModal) projectEditDeleteModal.style.display = 'none';
  currentProjectBox = null;
}

function showCreateProjectModal() {
  window.location.href = 'project_folder.html';
}

function closeCreateProjectModal() {
  if (createProjectModal) createProjectModal.style.display = 'none';
  creatingFromShotlistFeature = false;
  showCreateProjectNameStep();
}

function showCreateProjectNameStep() {
  if (createProjectNameStep) createProjectNameStep.style.display = 'block';
  if (createProjectOptions) createProjectOptions.style.display = 'none';
}

function showCreateProjectOptions() {
  if (createProjectNameStep) createProjectNameStep.style.display = 'none';
  if (createProjectOptions) createProjectOptions.style.display = 'block';
}

async function createProjectAndGoToAiScribe(projectName, scriptContent = "") {
  const newProject = {
    name: projectName,
    createdAt: new Date().toISOString(),
    scenes_general: [], scenes_storyboard: [], scenes_breakdown: [], scenes_scriptit: []
  };
  
  if (scriptContent && scriptContent.trim()) {
    newProject.ai_scripts = [{ content: scriptContent, createdAt: new Date().toISOString() }];
    // Save to persistent script storage for cross-page access
    localStorage.setItem('prepProjectScript', scriptContent);
  }

  try {
    const docRef = await addProject(newProject);
    localStorage.setItem('currentProjectId', docRef.id);
    localStorage.setItem('currentProjectName', projectName);
    
    if (scriptContent) {
      localStorage.setItem('currentProjectScript', scriptContent);
      localStorage.setItem('currentProjectScriptProjectId', docRef.id);
    }

    showToast("Project created! Redirecting to AI Scribe...", "success");
    setTimeout(() => {
      window.location.href = `ai_script.html?projectId=${docRef.id}`;
    }, 250);
  } catch (e) {
    console.error("Error creating project:", e);
    showToast("Error creating project. Please try again.", "error");
  }
}

function showShotlistEntryModal(feature) {
  if (!shotlistEntryModal) return;
  shotlistEntryModal.style.display = 'flex';
  createNewShotlistProjectBtn.style.display = 'block';
  viewExistingShotlistProjectsBtn.style.display = 'block';
  projectSearchInput.value = '';
  projectSearchInput.style.display = 'none';
  projectSelectionList.style.display = 'none';

  let sceneTypeToSet = null;
  switch (feature) {
    case 'screenplay':
      targetFeatureUrl = 'screenplay.html';
      break;
    case 'storyboard':
      // CHANGE: Now points to the unified scenes.html
      targetFeatureUrl = 'scenes.html'; 
      sceneTypeToSet = 'scenes_storyboard';
      break;
    case 'scriptit': 
      targetFeatureUrl = 'scenes_script.html'; 
      sceneTypeToSet = 'scenes_scriptit'; 
      break;
    case 'cast': 
      targetFeatureUrl = 'cast.html'; 
      break;
    case 'breakdown': 
      targetFeatureUrl = 'script_breakdown.html'; 
      sceneTypeToSet = 'scenes_breakdown'; 
      break;
    case 'shootdays':
      targetFeatureUrl = 'shoot_schedule.html';
      break;
    default: 
      // Shotlist (Default)
      targetFeatureUrl = 'scenes.html'; 
      sceneTypeToSet = 'scenes_general'; 
      break;
  }
  if (sceneTypeToSet) localStorage.setItem('currentSceneArrayType', sceneTypeToSet);
}


function closeShotlistEntryModal() {
  if (shotlistEntryModal) shotlistEntryModal.style.display = 'none';
  if (projectSelectionList) projectSelectionList.style.display = 'none';
}

function renderSelectableProjects(searchTerm = '') {
  if (!selectableProjectsContainer) return;
  selectableProjectsContainer.innerHTML = '';
  const lower = searchTerm.toLowerCase();
  const filtered = projects.filter(p => p.name.toLowerCase().includes(lower));

  if (filtered.length === 0) {
    noSelectableProjectsMessage.style.display = 'block';
    selectableProjectsContainer.style.display = 'none';
  } else {
    noSelectableProjectsMessage.style.display = 'none';
    selectableProjectsContainer.style.display = 'grid';
    filtered.forEach(project => {
      const box = document.createElement('div');
      box.className = 'selectable-project-box';
      box.textContent = project.name;
      box.dataset.projectId = project.id;
      box.addEventListener('click', (e) => {
        const id = e.currentTarget.dataset.projectId;
        localStorage.setItem('currentProjectId', id);
        localStorage.setItem('currentProjectName', project.name);
        closeShotlistEntryModal();
        window.location.href = `${targetFeatureUrl}?projectId=${id}`;
      });
      selectableProjectsContainer.appendChild(box);
    });
  }
}

// ================================================
// INTERACTIVE ONBOARDING TOUR SYSTEM
// ================================================

let currentTourStep = 0;
let tourSteps = [
  {
    title: "Welcome to PREP!",
    description: "Your cinematic pre-production OS. Let's get you started with a quick tour.",
    element: null,
    position: "center",
    action: null
  },
  {
    title: "Create Your First Project",
    description: "Click 'Create Project' to start organizing your film production. This is your foundation for everything else.",
    element: "#noProjectsCreateBtn",
    position: "bottom",
    action: () => {
      const createBtn = document.getElementById('noProjectsCreateBtn');
      if (createBtn) createBtn.click();
    }
  },
  {
    title: "Ready to Create!",
    description: "You've got the tools you need. Upload a script, use AI features, or explore the tools above. Welcome aboard!",
    element: ".feature-list",
    position: "top",
    action: null
  }
];

// Tour DOM elements
const tourOverlay = document.getElementById('tourOverlay');
const tourHighlight = document.getElementById('tourHighlight');
const tourTooltip = document.getElementById('tourTooltip');
const tourStepCounter = document.getElementById('tourStepCounter');
const tourTitle = document.getElementById('tourTitle');
const tourDescription = document.getElementById('tourDescription');
const tourPrev = document.getElementById('tourPrev');
const tourNext = document.getElementById('tourNext');
const tourFinish = document.getElementById('tourFinish');
const tourSkip = document.getElementById('tourSkip');
const tourClose = document.getElementById('tourClose');
const tourProgress = document.getElementById('tourProgress');

function initializeTour() {
  if (!tourProgress || !tourPrev || !tourNext || !tourFinish || !tourSkip || !tourClose) {
    console.warn('Tour control elements not ready');
    return;
  }

  // Create progress dots
  tourProgress.innerHTML = '';
  tourSteps.forEach((_, index) => {
    const dot = document.createElement('div');
    dot.className = 'tour-progress-dot';
    if (index === 0) dot.classList.add('active');
    tourProgress.appendChild(dot);
  });

  // Event listeners
  tourPrev.addEventListener('click', prevTourStep);
  tourNext.addEventListener('click', nextTourStep);
  tourFinish.addEventListener('click', finishTour);
  tourSkip.addEventListener('click', skipTour);
  tourClose.addEventListener('click', skipTour);
}

function showTour() {
  // Check if user has already seen the tour
  if (localStorage.getItem('welcomeGuideShown') === 'true') {
    return;
  }

  // Only show for users with no projects
  if (projects.length > 0) {
    return;
  }

  // Prevent multiple tour instances
  if (tourOverlay && tourOverlay.style.display === 'block') {
    return;
  }

  // Ensure DOM elements are ready
  if (!tourOverlay || !tourHighlight || !tourTooltip || !tourProgress || !tourTitle || !tourDescription) {
    console.warn('Tour elements not ready, will show welcome modal instead');
    showWelcomeModal();
    return;
  }

  currentTourStep = 0;
  tourOverlay.style.display = 'block';
  updateTourStep();
  initializeTour();
}

function hideTour() {
  if (tourOverlay) {
    tourOverlay.style.display = 'none';
  }
}

function updateTourStep() {
  if (!tourTitle || !tourDescription || !tourStepCounter || !tourProgress) {
    console.warn('Tour content elements not ready');
    return;
  }

  const step = tourSteps[currentTourStep];

  // Update content
  tourTitle.textContent = step.title;
  tourDescription.textContent = step.description;
  tourStepCounter.textContent = `Step ${currentTourStep + 1} of ${tourSteps.length}`;

  // Update progress dots
  const dots = tourProgress.querySelectorAll('.tour-progress-dot');
  dots.forEach((dot, index) => {
    dot.classList.toggle('active', index === currentTourStep);
  });

  // Update buttons
  if (tourPrev) tourPrev.style.display = currentTourStep === 0 ? 'none' : 'inline-block';
  if (tourNext) tourNext.style.display = currentTourStep === tourSteps.length - 1 ? 'none' : 'inline-block';
  if (tourFinish) tourFinish.style.display = currentTourStep === tourSteps.length - 1 ? 'inline-block' : 'none';

  // Position tooltip and highlight
  positionTourElements(step);
}

function positionTourElements(step) {
  if (!step.element) {
    // Center positioning for intro step
    tourTooltip.className = 'tour-tooltip';
    tourTooltip.style.top = '50%';
    tourTooltip.style.left = '50%';
    tourTooltip.style.transform = 'translate(-50%, -50%)';
    tourHighlight.style.display = 'none';
    return;
  }

  const targetElement = document.querySelector(step.element);
  if (!targetElement) return;

  // Show highlight
  tourHighlight.style.display = 'block';
  const rect = targetElement.getBoundingClientRect();
  tourHighlight.style.top = rect.top - 5 + 'px';
  tourHighlight.style.left = rect.left - 5 + 'px';
  tourHighlight.style.width = rect.width + 10 + 'px';
  tourHighlight.style.height = rect.height + 10 + 'px';

  // Position tooltip
  const tooltipRect = tourTooltip.getBoundingClientRect();
  let tooltipTop, tooltipLeft;

  switch (step.position) {
    case 'top':
      tooltipTop = rect.top - tooltipRect.height - 10;
      tooltipLeft = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
      tourTooltip.className = 'tour-tooltip top';
      break;
    case 'bottom':
      tooltipTop = rect.bottom + 10;
      tooltipLeft = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
      tourTooltip.className = 'tour-tooltip bottom';
      break;
    case 'left':
      tooltipTop = rect.top + (rect.height / 2) - (tooltipRect.height / 2);
      tooltipLeft = rect.left - tooltipRect.width - 10;
      tourTooltip.className = 'tour-tooltip left';
      break;
    case 'right':
      tooltipTop = rect.top + (rect.height / 2) - (tooltipRect.height / 2);
      tooltipLeft = rect.right + 10;
      tourTooltip.className = 'tour-tooltip right';
      break;
    default:
      tooltipTop = rect.top + (rect.height / 2) - (tooltipRect.height / 2);
      tooltipLeft = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
  }

  // Ensure tooltip stays within viewport
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  if (tooltipLeft < 10) tooltipLeft = 10;
  if (tooltipLeft + tooltipRect.width > viewportWidth - 10) {
    tooltipLeft = viewportWidth - tooltipRect.width - 10;
  }
  if (tooltipTop < 10) tooltipTop = 10;
  if (tooltipTop + tooltipRect.height > viewportHeight - 10) {
    tooltipTop = viewportHeight - tooltipRect.height - 10;
  }

  tourTooltip.style.top = tooltipTop + 'px';
  tourTooltip.style.left = tooltipLeft + 'px';
  tourTooltip.style.transform = 'none';
}

function nextTourStep() {
  if (currentTourStep < tourSteps.length - 1) {
    // Execute action for current step if it exists
    const currentStep = tourSteps[currentTourStep];
    if (currentStep.action) {
      currentStep.action();
    }

    currentTourStep++;
    updateTourStep();
  }
}

function prevTourStep() {
  if (currentTourStep > 0) {
    currentTourStep--;
    updateTourStep();
  }
}

function finishTour() {
  localStorage.setItem('welcomeGuideShown', 'true');
  hideTour();

  // Show success message and encourage immediate action
  showToast('🎬 Welcome to PREP! Ready to create your first project?', 'success');

  // Optionally open create project modal
  setTimeout(() => {
    if (projects.length === 0) {
      showCreateProjectModal();
    }
  }, 2000);
}

function skipTour() {
  localStorage.setItem('welcomeGuideShown', 'true');
  hideTour();
}

// ================================================
// LEGACY WELCOME MODAL (kept for compatibility)
// ================================================

function showWelcomeModal() {
  if (welcomeGuideModal && projects.length === 0 && !localStorage.getItem('welcomeGuideShown')) {
    welcomeGuideModal.style.display = 'block';
  }
}

function hideWelcomeGuide() {
  if (welcomeGuideModal) {
    welcomeGuideModal.style.display = 'none';
    localStorage.setItem('welcomeGuideShown', 'true');
  }
}

// Welcome modal event listeners (legacy)
const startTourBtn = document.getElementById('startTourBtn');
if (startTourBtn) {
  startTourBtn.addEventListener('click', () => {
    hideWelcomeGuide();
    showTour();
  });
}

if (startCreatingBtn) {
  startCreatingBtn.addEventListener('click', () => {
    hideWelcomeGuide();
    showCreateProjectModal();
  });
}

if (viewGuideBtn) {
  viewGuideBtn.addEventListener('click', () => {
    hideWelcomeGuide();
    window.location.href = 'guide.html';
  });
}

if (welcomeGuideModal) {
  welcomeGuideModal.addEventListener('click', (e) => {
    if (e.target === welcomeGuideModal) hideWelcomeGuide();
  });
}

// ================================================
// CATEGORY TABS FUNCTIONALITY
// ================================================

function initializeCategoryTabs() {
  const categoryTabs = document.querySelectorAll('.category-tab');
  
  categoryTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Remove active class from all tabs
      categoryTabs.forEach(t => t.classList.remove('active'));
      
      // Add active class to clicked tab
      tab.classList.add('active');
      
      // Get the category
      const category = tab.getAttribute('data-category');
      
      // Hide all features
      const featureCategories = document.querySelectorAll('.feature-category');
      featureCategories.forEach(fc => fc.style.display = 'none');
      
      // Show the selected category
      const selectedCategory = document.querySelector(`.feature-category[data-category="${category}"]`);
      if (selectedCategory) {
        selectedCategory.style.display = 'block';
      }
      
      // Log analytics event
      logAnalyticsEvent('category_tab_clicked', { category: category });
    });
  });
}

// ================================================
// JOIN WAITLIST FUNCTIONALITY
// ================================================

function initializeJoinWaitlist() {
  const joinWaitlistModal = document.getElementById('joinWaitlistModal');
  const closeWaitlistModal = document.getElementById('closeWaitlistModal');
  const submitWaitlistBtn = document.getElementById('submitWaitlistBtn');
  const cancelWaitlistBtn = document.getElementById('cancelWaitlistBtn');
  const joinWaitlistForm = document.getElementById('joinWaitlistForm');
  
  if (closeWaitlistModal) {
    closeWaitlistModal.addEventListener('click', () => {
      joinWaitlistModal.style.display = 'none';
    });
  }
  
  if (cancelWaitlistBtn) {
    cancelWaitlistBtn.addEventListener('click', () => {
      joinWaitlistModal.style.display = 'none';
    });
  }
  
  if (joinWaitlistForm) {
    joinWaitlistForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await handleJoinWaitlist();
    });
  }
  
  // Close modal when clicking outside
  if (joinWaitlistModal) {
    joinWaitlistModal.addEventListener('click', (e) => {
      if (e.target === joinWaitlistModal) {
        joinWaitlistModal.style.display = 'none';
      }
    });
  }
}

// Make function globally accessible
window.openJoinWaitlistModal = function(featureName) {
  const joinWaitlistModal = document.getElementById('joinWaitlistModal');
  const waitlistFeatureName = document.getElementById('waitlistFeatureName');
  const waitlistEmailInput = document.getElementById('waitlistEmail');
  const waitlistNameInput = document.getElementById('waitlistName');
  
  // Set feature name
  if (waitlistFeatureName) {
    waitlistFeatureName.textContent = featureName;
  }
  
  // Clear previous inputs
  if (waitlistEmailInput) waitlistEmailInput.value = '';
  if (waitlistNameInput) waitlistNameInput.value = '';
  
  // Get current user email if available
  if (auth.currentUser && auth.currentUser.email) {
    if (waitlistEmailInput) waitlistEmailInput.value = auth.currentUser.email;
  }
  
  // Show modal
  if (joinWaitlistModal) {
    joinWaitlistModal.style.display = 'flex';
  }
  
  // Log analytics
  logAnalyticsEvent('join_waitlist_opened', { feature: featureName });
};

async function handleJoinWaitlist() {
  const joinWaitlistModal = document.getElementById('joinWaitlistModal');
  const waitlistEmailInput = document.getElementById('waitlistEmail');
  const waitlistNameInput = document.getElementById('waitlistName');
  const waitlistNotifications = document.getElementById('waitlistNotifications');
  const submitWaitlistBtn = document.getElementById('submitWaitlistBtn');
  const submitWaitlistBtnText = document.getElementById('submitWaitlistBtnText');
  const submitWaitlistSpinner = document.getElementById('submitWaitlistSpinner');
  const waitlistFeatureName = document.getElementById('waitlistFeatureName');
  const waitlistEmailError = document.getElementById('waitlistEmailError');
  
  const email = waitlistEmailInput?.value.trim();
  const name = waitlistNameInput?.value.trim() || 'Anonymous';
  const featureName = waitlistFeatureName?.textContent || 'Unknown Feature';
  const receiveUpdates = waitlistNotifications?.checked || false;
  
  // Validate email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    if (waitlistEmailError) {
      waitlistEmailError.textContent = 'Please enter a valid email address.';
      waitlistEmailError.style.display = 'block';
    }
    return;
  }
  
  if (waitlistEmailError) {
    waitlistEmailError.style.display = 'none';
  }
  
  // Show loading state
  if (submitWaitlistBtn) submitWaitlistBtn.disabled = true;
  if (submitWaitlistBtnText) submitWaitlistBtnText.textContent = 'Joining...';
  if (submitWaitlistSpinner) submitWaitlistSpinner.style.display = 'flex';
  
  try {
    // Send to backend/email service
    const response = await fetch('/api/join-waitlist', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: email,
        name: name,
        feature: featureName,
        receiveUpdates: receiveUpdates,
        userId: auth.currentUser?.uid || null,
        timestamp: new Date().toISOString()
      })
    }).catch(() => {
      // Fallback if API doesn't exist - still show success
      return { ok: true };
    });
    
    // Log analytics
    logAnalyticsEvent('joined_waitlist', {
      feature: featureName,
      email: email
    });
    
    // Show success
    if (submitWaitlistBtnText) submitWaitlistBtnText.textContent = '✓ Joined!';
    
    // Close modal after delay
    setTimeout(() => {
      if (joinWaitlistModal) {
        joinWaitlistModal.style.display = 'none';
      }
      
      // Reset button
      if (submitWaitlistBtn) submitWaitlistBtn.disabled = false;
      if (submitWaitlistBtnText) submitWaitlistBtnText.textContent = 'Join Waitlist';
      if (submitWaitlistSpinner) submitWaitlistSpinner.style.display = 'none';
    }, 1500);
    
  } catch (error) {
    console.error('Error joining waitlist:', error);
    if (waitlistEmailError) {
      waitlistEmailError.textContent = 'Error joining waitlist. Please try again.';
      waitlistEmailError.style.display = 'block';
    }
    
    // Reset button
    if (submitWaitlistBtn) submitWaitlistBtn.disabled = false;
    if (submitWaitlistBtnText) submitWaitlistBtnText.textContent = 'Join Waitlist';
    if (submitWaitlistSpinner) submitWaitlistSpinner.style.display = 'none';
  }
}

// ================================================
// TOUR EVENT LISTENERS
// ================================================

function attachTourEventListeners() {
  // Start tour from welcome guide button
  const startTourBtn = document.getElementById('startTourBtn');
  if (startTourBtn) {
    startTourBtn.addEventListener('click', () => {
      if (typeof startTour === 'function') {
        startTour();
      }
    });
  }
  
  // Start tour from three-dots menu
  const startTourItem = document.getElementById('startTourItem');
  if (startTourItem) {
    startTourItem.addEventListener('click', () => {
      // Close the menu
      const userMenuDropdown = document.getElementById('userMenuDropdown');
      if (userMenuDropdown) {
        userMenuDropdown.style.display = 'none';
      }
      // Start tour
      if (typeof startTour === 'function') {
        startTour();
      }
    });
  }
  
  // Start creating from welcome guide button
  const startCreatingBtn = document.getElementById('startCreatingBtn');
  if (startCreatingBtn) {
    startCreatingBtn.addEventListener('click', () => {
      hideWelcomeGuide();
      window.location.href = 'project_folder.html';
    });
  }
}

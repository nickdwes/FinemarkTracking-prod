(() => {
  const ROLES = Object.freeze({
    SALES: "sales",
    TECHNICAL: "technical",
    TECHNICIAN: "technician",
    ADMIN: "admin",
    FINANCE: "finance",
  });

  const REQUEST_TYPES = Object.freeze({
    INSTALLATION: "installation",
    QUOTATION: "quotation",
    INVOICE: "invoice",
  });

  const INSTALLATION_STATUS = Object.freeze({
    REQUESTED: "Requested",
    ASSIGNED: "Assigned",
    IN_PROGRESS: "In Progress",
    AWAITING_CONFIRMATION: "Awaiting Confirmation",
    COMPLETED: "Completed",
    RESCHEDULED: "Rescheduled",
    FAILED: "Failed",
  });

  const INSTALLATION_TRANSITIONS = Object.freeze({
    [INSTALLATION_STATUS.REQUESTED]: [INSTALLATION_STATUS.ASSIGNED],
    [INSTALLATION_STATUS.ASSIGNED]: [INSTALLATION_STATUS.IN_PROGRESS],
    [INSTALLATION_STATUS.IN_PROGRESS]: [INSTALLATION_STATUS.AWAITING_CONFIRMATION],
    [INSTALLATION_STATUS.AWAITING_CONFIRMATION]: [
      INSTALLATION_STATUS.COMPLETED,
      INSTALLATION_STATUS.RESCHEDULED,
      INSTALLATION_STATUS.FAILED,
    ],
    [INSTALLATION_STATUS.RESCHEDULED]: [INSTALLATION_STATUS.ASSIGNED],
    [INSTALLATION_STATUS.COMPLETED]: [],
    [INSTALLATION_STATUS.FAILED]: [],
  });

  const canTransitionInstallation = (fromStatus, toStatus) => {
    const allowed = INSTALLATION_TRANSITIONS[fromStatus] || [];
    return allowed.includes(toStatus);
  };

  const assertTransitionInstallation = (fromStatus, toStatus) => {
    if (!canTransitionInstallation(fromStatus, toStatus)) {
      throw new Error(`Invalid installation status transition from "${fromStatus}" to "${toStatus}".`);
    }
  };

  /**
   * @param {Object} params
   * @returns {{id:string,email:string,role:string,createdAt:string,status:string}}
   */
  const createUser = (params) => ({
    id: params.id,
    email: params.email,
    role: params.role,
    createdAt: params.createdAt || new Date().toISOString(),
    status: params.status || "Active",
  });

  /**
   * @param {Object} params
   * @returns {{id:string,type:string,customer:string,location:string,status:string,createdAt:string,updatedAt:string,owner:string}}
   */
  const createRequest = (params) => ({
    id: params.id,
    type: params.type,
    customer: params.customer,
    location: params.location,
    status: params.status || "Draft",
    createdAt: params.createdAt || new Date().toISOString(),
    updatedAt: params.updatedAt || new Date().toISOString(),
    owner: params.owner || "demo@finemark.com",
  });

  /**
   * @param {Object} params
   * @returns {Object}
   */
  const createInstallationJob = (params) => ({
    id: params.id,
    requestId: params.requestId,
    customerName: params.customerName,
    customerPhone: params.customerPhone || "",
    location: params.location,
    scheduledDate: params.scheduledDate || "",
    assignedTechnician: params.assignedTechnician || "",
    status: params.status || INSTALLATION_STATUS.REQUESTED,
    jobDetails: params.jobDetails || { products: [], notes: "" },
    jobCard: params.jobCard || { checklist: [], photos: [] },
    confirmation: params.confirmation || { method: "", verified: false },
    createdAt: params.createdAt || new Date().toISOString(),
    updatedAt: params.updatedAt || new Date().toISOString(),
  });

  /**
   * @param {Object} params
   * @returns {{id:string,requestId:string,amount:number,currency:string,status:string,issuedAt:string}}
   */
  const createInvoice = (params) => ({
    id: params.id,
    requestId: params.requestId,
    amount: params.amount,
    currency: params.currency || "KES",
    status: params.status || "Draft",
    issuedAt: params.issuedAt || new Date().toISOString(),
  });

  /**
   * @param {Object} params
   * @returns {{id:string,requestId:string,amount:number,currency:string,status:string,issuedAt:string}}
   */
  const createQuote = (params) => ({
    id: params.id,
    requestId: params.requestId,
    amount: params.amount,
    currency: params.currency || "KES",
    status: params.status || "Draft",
    issuedAt: params.issuedAt || new Date().toISOString(),
  });

  /**
   * @param {Object} params
   * @returns {{id:string,client:string,invoiceId:string,amount:number,currency:string,status:string,createdAt:string}}
   */
  const createPayment = (params) => ({
    id: params.id,
    client: params.client,
    invoiceId: params.invoiceId,
    amount: params.amount,
    currency: params.currency || "KES",
    status: params.status || "Completed",
    createdAt: params.createdAt || new Date().toISOString(),
  });

  /**
   * @param {Object} params
   * @returns {{id:string,user:string,action:string,target:string,severity:string,ipAddress:string,timestamp:string}}
   */
  const createAuditLog = (params) => ({
    id: params.id,
    user: params.user,
    action: params.action,
    target: params.target,
    severity: params.severity || "Info",
    ipAddress: params.ipAddress || "127.0.0.1",
    timestamp: params.timestamp || new Date().toISOString(),
  });

  window.FINEMARK_CONTRACTS = {
    ROLES,
    REQUEST_TYPES,
    INSTALLATION_STATUS,
    INSTALLATION_TRANSITIONS,
    canTransitionInstallation,
    assertTransitionInstallation,
    createUser,
    createRequest,
    createInstallationJob,
    createInvoice,
    createQuote,
    createPayment,
    createAuditLog,
  };
})();

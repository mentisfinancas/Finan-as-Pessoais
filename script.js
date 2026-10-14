const DEFAULT_CATEGORIES = {

    income: [
        "Salário",
        "Freelance",
        "Investimentos",
        "Outras receitas"
    ],

    expense: [
        "Alimentação",
        "Moradia",
        "Transporte",
        "Saúde",
        "Lazer",
        "Compras",
        "Educação",
        "Contas",
        "Outros"
    ]

};

const CATEGORY_STORAGE_KEY = "financas_pessoais_categorias";
let categories = JSON.parse(
    localStorage.getItem(CATEGORY_STORAGE_KEY) ||
    JSON.stringify(DEFAULT_CATEGORIES)
);

function saveCategories() {
    localStorage.setItem(CATEGORY_STORAGE_KEY, JSON.stringify(categories));
}


const STORAGE_KEY =
    "financas_pessoais_lancamentos";


let transactions =
    JSON.parse(
        localStorage.getItem(STORAGE_KEY) || "[]"
    );

let supabaseClient = null;
let currentUser = null;
let cloudLoadPromise = null;
let selectedCashflowFilter = "all";


const $ = id =>
    document.getElementById(id);


function money(value) {

    return value.toLocaleString(
        "pt-BR",
        {
            style: "currency",
            currency: "BRL"
        }
    );

}


function today() {

    return new Date()
        .toISOString()
        .slice(0, 10);

}


function currentMonth() {

    return new Date()
        .toISOString()
        .slice(0, 7);

}


function save() {

    localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(transactions)
    );

}


/* FILTRAR POR MÊS */

function filteredTransactions() {

    const month =
        $("month-filter").value;


    if (!month) {

        return transactions;

    }


    return transactions.filter(
        transaction =>
            transaction.date.startsWith(month)
    );

}


/* CATEGORIAS DO FORMULÁRIO */

function updateCategoryOptions() {

    const type =
        document.querySelector(
            'input[name="type"]:checked'
        ).value;


    $("category").innerHTML =
        categories[type]
            .map(category => `
                <option value="${category}">
                    ${category}
                </option>
            `)
            .join("");

    const statusLabel = $("confirmed-status-label");
    if (statusLabel) {
        statusLabel.textContent = type === "income" ? "Recebido" : "Pago";
    }

}


/* ABRIR MODAL */

let editingTransactionId = null;

function openModal(transaction = null) {

    editingTransactionId = transaction ? transaction.id : null;

    $("modal")
        .classList
        .remove("hidden");


    $("transaction-form").reset();
    $("transaction-installments").checked = false;
    $("transaction-installments").disabled = false;
    $("transaction-installments").closest("label").classList.remove("hidden");
    $("installment-count-field").classList.add("hidden");
    $("transaction-fixed").closest("label").classList.remove("hidden");
    $("installment-preview").textContent = "";

    const installmentToEdit = transaction ? getInstallmentMetadata(transaction.note) : null;
    $("transaction-modal-title").textContent = installmentToEdit
        ? `Editar parcela ${installmentToEdit.index}/${installmentToEdit.count}`
        : transaction
        ? "Editar lançamento"
        : "Novo lançamento";


    $("date").value =
        today();


    updateCategoryOptions();

    if (transaction) {
        const typeRadio = document.querySelector(`input[name="type"][value="${transaction.type}"]`);
        if (!typeRadio) {
            alert("Não foi possível identificar se este lançamento é receita ou despesa.");
            closeModal();
            return;
        }
        typeRadio.checked = true;
        updateCategoryOptions();
        $("description").value = transaction.description ?? transaction.descricao ?? "";
        $("value").value = transaction.value == null ? "" : money(Number(transaction.value));
        $("date").value = transaction.date ?? "";
        $("category").value = transaction.category ?? "";
        $("note").value = String(transaction.note || "")
            .replace(ALLOCATION_META_PATTERN, "")
            .replace(INSTALLMENT_META_PATTERN, "")
            .trim();
        if (getInstallmentMetadata(transaction.note)) {
            $("transaction-installments").closest("label").classList.add("hidden");
            $("transaction-fixed").checked = false;
            $("transaction-fixed").closest("label").classList.add("hidden");
        } else {
            $("transaction-fixed").checked = Boolean(transaction.is_fixed);
        }
        $("transaction-status").value = transaction.status || "confirmed";
    }

}

function transactionRow(transaction) {
    return {
        ...transaction,
        user_id: currentUser.id,
        status: transaction.status || "confirmed",
        is_fixed: Boolean(transaction.is_fixed)
    };
}

async function upsertCloudTransaction(transaction) {
    if (!supabaseClient || !currentUser) return;
    const { error } = await supabaseClient
        .from("transactions")
        .upsert(transactionRow(transaction));
    if (error) throw error;
}

async function upsertCloudTransactions(items) {
    if (!supabaseClient || !currentUser || !items.length) return;
    const { error } = await supabaseClient
        .from("transactions")
        .upsert(items.map(transactionRow));
    if (error) throw error;
}

async function deleteCloudTransaction(id) {
    if (!supabaseClient || !currentUser) return;
    const { error } = await supabaseClient
        .from("transactions")
        .delete()
        .eq("id", id)
        .eq("user_id", currentUser.id);
    if (error) throw error;
}

async function upsertCloudCategories(categoryList) {
    if (!supabaseClient || !currentUser || !categoryList.length) return;
    const rows = categoryList.map(({ name, type }) => ({
        user_id: currentUser.id,
        name,
        type
    }));
    const { error } = await supabaseClient
        .from("categories")
        .upsert(rows, { onConflict: "user_id,name" });
    if (error) throw error;
}

async function deleteCloudCategory(name) {
    if (!supabaseClient || !currentUser) return;
    const { error } = await supabaseClient
        .from("categories")
        .delete()
        .eq("user_id", currentUser.id)
        .eq("name", name);
    if (error) throw error;
}

async function syncAllTransactionsToCloud() {
    if (!supabaseClient || !currentUser || !transactions.length) return;
    const { error } = await supabaseClient
        .from("transactions")
        .upsert(transactions.map(transactionRow));
    if (error) throw error;
}

async function loadCloudData(user) {
    if (cloudLoadPromise) return cloudLoadPromise;

    cloudLoadPromise = (async () => {
        currentUser = user;
        const migrationKey = "supabase_local_data_migrated";
        const shouldMigrateLocal = localStorage.getItem(migrationKey) !== "done";
        const localTransactions = [...transactions];
        const localCategories = JSON.parse(JSON.stringify(categories));

        const [transactionResult, categoryResult, profileResult] = await Promise.all([
            supabaseClient.from("transactions").select("*").order("date", { ascending: true }),
            supabaseClient.from("categories").select("*").order("name", { ascending: true }),
            supabaseClient.from("profiles").select("username").eq("user_id", user.id).maybeSingle()
        ]);
        if (transactionResult.error) throw transactionResult.error;
        if (categoryResult.error) throw categoryResult.error;
        if (profileResult.error) throw profileResult.error;

        let profile = profileResult.data;
        if (!profile) {
            const username = user.user_metadata?.username;
            if (!username) throw new Error("Perfil de usuário não encontrado.");
            const { error } = await supabaseClient
                .from("profiles")
                .insert({ user_id: user.id, username });
            if (error) throw error;
            profile = { username };
        }

        let cloudTransactions = transactionResult.data || [];
        let cloudCategories = categoryResult.data || [];

        if (shouldMigrateLocal) {
            const mergedTransactions = new Map(cloudTransactions.map(item => [item.id, item]));
            localTransactions.forEach(item => {
                mergedTransactions.set(item.id, transactionRow(item));
            });
            const transactionRows = [...mergedTransactions.values()];
            if (transactionRows.length) {
                const { error } = await supabaseClient.from("transactions").upsert(transactionRows);
                if (error) throw error;
                cloudTransactions = transactionRows;
            }

            const mergedCategories = new Map(cloudCategories.map(item => [item.name, item]));
            ["income", "expense"].forEach(type => {
                (localCategories[type] || []).forEach(name => {
                    mergedCategories.set(name, { user_id: user.id, name, type });
                });
            });
            const categoryRows = [...mergedCategories.values()].map(({ name, type }) => ({ name, type }));
            await upsertCloudCategories(categoryRows);
            cloudCategories = categoryRows;
            localStorage.setItem(migrationKey, "done");
        }

        transactions = cloudTransactions.map(({ user_id, created_at, updated_at, ...item }) => ({
            ...item,
            value: Number(item.value),
            status: item.status || "confirmed",
            is_fixed: Boolean(item.is_fixed)
        }));
        categories = {
            income: cloudCategories.filter(item => item.type === "income").map(item => item.name),
            expense: cloudCategories.filter(item => item.type === "expense").map(item => item.name)
        };

        save();
        saveCategories();
        renderAll();
        $("signed-in-user").textContent = profile.username;
        document.body.classList.remove("signed-out");
        $("auth-message").textContent = "";
    })();

    try {
        await cloudLoadPromise;
    } finally {
        cloudLoadPromise = null;
    }
}

function showAuthMessage(message, isError = false) {
    const element = $("auth-message");
    element.textContent = message;
    element.classList.toggle("error", isError);
}

async function initializeSupabase() {
    const config = window.SUPABASE_CONFIG;
    if (!window.supabase?.createClient) {
        showAuthMessage("A biblioteca do Supabase não carregou. Verifique a internet e atualize a página.", true);
        return;
    }
    if (!config?.url || !config?.publishableKey) {
        showAuthMessage("Configure a Project URL e a chave pública do Supabase em supabase-config.js.", true);
        return;
    }

    try {
        supabaseClient = window.supabase.createClient(config.url, config.publishableKey);
        supabaseClient.auth.onAuthStateChange((event, session) => {
            if (!session) {
                currentUser = null;
                document.body.classList.add("signed-out");
                return;
            }
            if (["INITIAL_SESSION", "SIGNED_IN", "TOKEN_REFRESHED"].includes(event)) {
                currentUser = session.user;
                setTimeout(() => loadCloudData(session.user).catch(error => {
                    showAuthMessage(`Login efetuado, mas não consegui abrir seus dados: ${error.message}. Confira se executou supabase-schema.sql no Supabase.`, true);
                }), 0);
            }
        });
    } catch (error) {
        supabaseClient = null;
        showAuthMessage(`Não foi possível iniciar o Supabase: ${error.message}`, true);
    }
}

function authErrorMessage(error) {
    const message = error?.message || "Não foi possível conectar ao Supabase.";
    if (/invalid login credentials/i.test(message)) return "Usuário ou senha incorretos. Se ainda não criou a conta, clique em Criar conta.";
    if (/email.*(invalid|valid)|invalid.*email/i.test(message)) return "O Supabase recusou o e-mail interno usado para login por usuário. Verifique a configuração de autenticação do projeto.";
    if (/fetch|network|failed to fetch/i.test(message)) return "Não consegui conectar ao Supabase. Confira sua internet e se a Project URL está correta.";
    return message;
}

let authenticationInProgress = false;

async function authenticate(action) {
    if (authenticationInProgress) return;
    if (!supabaseClient) {
        showAuthMessage("A conexão com Supabase não iniciou. Veja a mensagem de configuração acima e atualize a página.", true);
        return;
    }

    const username = $("auth-username").value.trim().toLowerCase();
    const password = $("auth-password").value;
    if (!/^[a-z0-9_]{3,30}$/.test(username)) {
        showAuthMessage("Use de 3 a 30 caracteres: letras sem acento, números ou _. Ex.: jose_gabriel", true);
        return;
    }
    if (password.length < 6) {
        showAuthMessage("A senha precisa ter pelo menos 6 caracteres.", true);
        return;
    }

    const internalAuthEmail = `${username}@users.financas.invalid`;
    authenticationInProgress = true;
    const signInButton = $("auth-sign-in");
    const signUpButton = $("auth-sign-up");
    signInButton.disabled = signUpButton.disabled = true;
    showAuthMessage(action === "signup" ? "Criando conta..." : "Entrando...");

    try {
        const result = action === "signup"
            ? await supabaseClient.auth.signUp({
                email: internalAuthEmail,
                password,
                options: { data: { username } }
            })
            : await supabaseClient.auth.signInWithPassword({
                email: internalAuthEmail,
                password
            });

        if (result.error) throw result.error;
        if (action === "signup" && !result.data.session) {
            showAuthMessage("Conta criada, mas o Supabase exige confirmação por e-mail. Desative a confirmação de e-mail em Authentication → Sign In / Providers → Email para usar somente nome de usuário.", true);
            return;
        }
        showAuthMessage("Acesso autorizado. Carregando seus dados...");
    } catch (error) {
        showAuthMessage(authErrorMessage(error), true);
    } finally {
        authenticationInProgress = false;
        signInButton.disabled = signUpButton.disabled = false;
    }
}

function parseCurrencyInput(value) {
    const cents = String(value).replace(/\D/g, "");
    return cents ? Number(cents) / 100 : 0;
}

const ALLOCATION_META_PATTERN = /\[\[ALLOCATION_V1:([^\]]+)\]\]/;
const INSTALLMENT_META_PATTERN = /\[\[INSTALLMENT_V1:([^\]]+)\]\]/;

function getInstallmentMetadata(note = "") {
    const match = String(note).match(INSTALLMENT_META_PATTERN);
    if (!match) return null;
    try {
        const metadata = JSON.parse(decodeURIComponent(match[1]));
        return metadata && metadata.groupId && Number(metadata.count) > 1 ? metadata : null;
    } catch {
        return null;
    }
}

function composeInstallmentNote(note, metadata) {
    const cleanNote = String(note || "").replace(INSTALLMENT_META_PATTERN, "").trim();
    const marker = `[[INSTALLMENT_V1:${encodeURIComponent(JSON.stringify(metadata))}]]`;
    return [cleanNote, marker].filter(Boolean).join("\n\n");
}

function installmentLabel(transaction) {
    const metadata = getInstallmentMetadata(transaction.note);
    if (!metadata) return "";
    const [year, month] = transaction.date.split("-").map(Number);
    const installmentMonth = new Date(year, month - 1, 1).toLocaleDateString("pt-BR", {
        month: "short",
        year: "numeric"
    });
    return `Parcela ${metadata.index}/${metadata.count} · ${installmentMonth}`;
}

function installmentDate(baseDate, offset) {
    const [year, month, day] = baseDate.split("-").map(Number);
    const targetMonthStart = new Date(Date.UTC(year, month - 1 + offset, 1));
    const lastDay = new Date(Date.UTC(targetMonthStart.getUTCFullYear(), targetMonthStart.getUTCMonth() + 1, 0)).getUTCDate();
    return `${targetMonthStart.getUTCFullYear()}-${String(targetMonthStart.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

function getAllocationMetadata(note = "") {
    const match = String(note).match(ALLOCATION_META_PATTERN);
    if (!match) return null;
    try {
        const metadata = JSON.parse(decodeURIComponent(match[1]));
        return metadata && Array.isArray(metadata.items) ? metadata : null;
    } catch {
        return null;
    }
}

function composeAllocationNote(note, metadata) {
    let cleanNote = String(note || "").replace(ALLOCATION_META_PATTERN, "").trim();
    cleanNote = cleanNote.replace(/\n{0,2}Detalhamento do rateio:\n[\s\S]*$/i, "").trim();
    const detailRows = metadata.items.map(item =>
        `• ${item.description}${item.category ? ` — ${item.category}` : ""}: ${money(Number(item.value))}`
    );
    const detailText = `Detalhamento do rateio:\n${detailRows.join("\n")}`;
    const marker = `[[ALLOCATION_V1:${encodeURIComponent(JSON.stringify(metadata))}]]`;
    return [cleanNote, detailText, marker].filter(Boolean).join("\n\n");
}

function transactionCategoryLabel(transaction) {
    const metadata = getAllocationMetadata(transaction.note);
    if (!metadata) return transaction.category;
    const itemCategories = metadata.items.map(item => item.category).filter(Boolean);
    const categoryCount = new Set(itemCategories).size;
    if (categoryCount > 1) return `Rateio · ${categoryCount} categorias`;
    return itemCategories[0] || transaction.category;
}

function transactionAllocationLabel(transaction) {
    const metadata = getAllocationMetadata(transaction.note);
    if (!metadata) return "";
    return metadata.mode === "split"
        ? `Rateio · ${metadata.items.length} ${metadata.items.length === 1 ? "item" : "itens"}`
        : `Somado · ${metadata.items.length} ${metadata.items.length === 1 ? "item" : "itens"}`;
}

function renderAllocationDetailsHTML(transaction) {
    const metadata = getAllocationMetadata(transaction.note);
    if (!metadata) return "";
    const items = metadata.items.map(item => `
        <li>
            <span>${escapeHTML(item.description)}${item.category ? ` · ${escapeHTML(item.category)}` : ""}</span>
            <strong>${money(Number(item.value))}</strong>
        </li>`).join("");
    return `<details class="allocation-details"><summary>Ver detalhamento</summary><ul>${items}</ul></details>`;
}

let allocationMode = "split";
let allocationEditingId = null;

function getAllocationUserNote(note = "") {
    return String(note || "")
        .replace(ALLOCATION_META_PATTERN, "")
        .replace(/\n{0,2}Detalhamento do rateio:\n[\s\S]*$/i, "")
        .trim();
}

function allocationCategoryOptions(selected = "") {
    if (!categories.expense.length) return '<option value="">Cadastre uma categoria de despesa</option>';
    return categories.expense.map(name => `
        <option value="${escapeHTML(name)}" ${name === selected ? "selected" : ""}>${escapeHTML(name)}</option>
    `).join("");
}

function renderAllocationLines(items = [{}]) {
    const lines = $("allocation-lines");
    if (!lines) return;
    lines.innerHTML = "";
    (items.length ? items : [{}]).forEach(item => appendAllocationLine(item));
    updateAllocationSummary();
}

function appendAllocationLine(item = {}) {
    const line = document.createElement("div");
    line.className = "allocation-line";
    line.innerHTML = `
        <input class="allocation-item-name" type="text" maxlength="80" placeholder="Item (ex.: mercado)" aria-label="Nome do item" value="${escapeHTML(item.description || "")}">
        <select class="allocation-item-category" aria-label="Categoria do item">${allocationCategoryOptions(item.category || "")}</select>
        <input class="allocation-line-value" type="text" inputmode="decimal" placeholder="R$ 0,00" aria-label="Valor distribuído" value="${item.value ? money(Number(item.value)) : ""}">
        <button class="remove-allocation-line" type="button" aria-label="Remover item">×</button>`;
    $("allocation-lines").append(line);
}

function updateAllocationSplitSummary() {
    const target = $("allocation-split-summary");
    if (!target) return;

    const total = parseCurrencyInput($("allocation-total").value);
    const allocated = [...document.querySelectorAll(".allocation-line-value")]
        .reduce((sum, input) => sum + parseCurrencyInput(input.value), 0);
    const difference = total - allocated;
    target.classList.toggle("invalid", total <= 0 || Math.abs(difference) >= 0.01);
    target.textContent = total > 0
        ? `Distribuído: ${money(allocated)} de ${money(total)}${Math.abs(difference) < 0.01 ? " · Valor fechado" : ` · Falta distribuir ${money(Math.max(difference, 0))}`}`
        : `Distribuído: ${money(allocated)} · Informe o valor total.`;
}

function updateAllocationSummary() {
    if (allocationMode === "split") {
        updateAllocationSplitSummary();
        return;
    }
    const items = [...document.querySelectorAll(".allocation-line")];
    const total = items.reduce((sum, line) => sum + parseCurrencyInput(line.querySelector(".allocation-line-value").value), 0);
    $("allocation-aggregate-summary").textContent = `Total do lançamento único: ${money(total)}`;
}

function setAllocationMode(mode) {
    allocationMode = mode;
    const isSplit = mode === "split";
    $("allocation-split-fields").classList.toggle("hidden", !isSplit);
    $("allocation-aggregate-fields").classList.toggle("hidden", isSplit);
    $("allocation-mode-split").classList.toggle("active", isSplit);
    $("allocation-mode-aggregate").classList.toggle("active", !isSplit);
    $("allocation-mode-split").setAttribute("aria-selected", String(isSplit));
    $("allocation-mode-aggregate").setAttribute("aria-selected", String(!isSplit));
    $("allocation-lines-title").textContent = isSplit ? "Distribuição por item/categoria" : "Gastos somados por item/categoria";
    updateAllocationSummary();
}

function openAllocationModal(transaction = null) {
    $("allocation-form").reset();
    allocationEditingId = transaction?.id || null;
    $("allocation-date").value = transaction?.date || today();
    $("allocation-status").value = transaction?.status || "pending";
    $("allocation-note").value = getAllocationUserNote(transaction?.note);
    $("allocation-total").value = "";
    const metadata = transaction ? getAllocationMetadata(transaction.note) : null;
    const mode = metadata?.mode === "aggregate" ? "aggregate" : "split";
    setAllocationMode(mode);
    if (transaction && mode === "split") {
        $("allocation-bundle-description").value = transaction.description || "";
        $("allocation-total").value = money(Number(transaction.value) || 0);
        renderAllocationLines(metadata?.items || []);
    } else if (transaction) {
        $("allocation-bundle-description").value = transaction.description || "";
        renderAllocationLines(metadata?.items || []);
    } else {
        renderAllocationLines();
    }
    updateAllocationSummary();
    $("allocation-modal-title").textContent = transaction ? "Editar rateio" : "Fazer rateio";
    $("allocation-save-button").textContent = transaction ? "Atualizar rateio" : "Salvar rateio";
    $("allocation-modal").classList.remove("hidden");
}

function closeAllocationModal() {
    $("allocation-modal").classList.add("hidden");
    allocationEditingId = null;
}

async function saveAllocation(event) {
    event.preventDefault();
    const date = $("allocation-date").value;
    const status = $("allocation-status").value;
    const note = $("allocation-note").value.trim();
    let newTransactions = [];

    if (allocationMode === "split") {
        const description = $("allocation-bundle-description").value.trim();
        const total = parseCurrencyInput($("allocation-total").value);
        const lineItems = [...document.querySelectorAll(".allocation-line")].map(line => ({
            description: line.querySelector(".allocation-item-name").value.trim(),
            category: line.querySelector(".allocation-item-category").value,
            value: parseCurrencyInput(line.querySelector(".allocation-line-value").value)
        }));
        const allocated = lineItems.reduce((sum, item) => sum + item.value, 0);

        if (!description || total <= 0 || !lineItems.length || lineItems.some(item => !item.description || !item.category || item.value <= 0)) {
            alert("Informe a descrição do lançamento, o total e nome, categoria e valor para cada item.");
            return;
        }
        if (Math.abs(total - allocated) >= 0.01) {
            alert(`A soma dos itens (${money(allocated)}) precisa ser igual ao valor total (${money(total)}).`);
            return;
        }

        newTransactions = [{
            id: allocationEditingId || crypto.randomUUID(),
            description,
            value: total,
            date,
            category: lineItems[0].category,
            type: "expense",
            status,
            note: composeAllocationNote(note, { mode: "split", items: lineItems }),
            is_fixed: false
        }];
    } else {
        const description = $("allocation-bundle-description").value.trim();
        const lineItems = [...document.querySelectorAll(".allocation-line")].map(line => ({
            description: line.querySelector(".allocation-item-name").value.trim(),
            category: line.querySelector(".allocation-item-category").value,
            value: parseCurrencyInput(line.querySelector(".allocation-line-value").value)
        }));
        const total = lineItems.reduce((sum, item) => sum + item.value, 0);
        if (!description || !lineItems.length || lineItems.some(item => !item.description || !item.category || item.value <= 0) || total <= 0) {
            alert("Informe a descrição do lançamento e nome, categoria e valor para cada gasto.");
            return;
        }

        newTransactions = [{
            id: allocationEditingId || crypto.randomUUID(),
            description,
            value: total,
            date,
            category: lineItems[0].category,
            type: "expense",
            status,
            note: composeAllocationNote(note, { mode: "aggregate", items: lineItems }),
            is_fixed: false
        }];
    }

    try {
        await upsertCloudTransactions(newTransactions);
    } catch (error) {
        alert(`Não foi possível salvar o rateio no Supabase: ${error.message}`);
        return;
    }

    if (allocationEditingId) {
        transactions = transactions.map(transaction => transaction.id === allocationEditingId ? newTransactions[0] : transaction);
    } else {
        transactions.push(...newTransactions);
    }
    save();
    closeAllocationModal();
    renderAll();
}


/* FECHAR MODAL */

function closeModal() {

    $("modal")
        .classList
        .add("hidden");

}


/* DASHBOARD */

function renderDashboard() {

    const data =
        filteredTransactions();


    const income =
        data
            .filter(t => t.type === "income")
            .reduce(
                (sum, t) =>
                    sum + t.value,
                0
            );


    const expense =
        data
            .filter(t => t.type === "expense")
            .reduce(
                (sum, t) =>
                    sum + t.value,
                0
            );


    const balance =
        income - expense;


    $("balance").textContent =
        money(balance);


    $("income").textContent =
        money(income);


    $("expense").textContent =
        money(expense);


    $("count").textContent =
        data.length;


    renderIncomeExpenseChart(data);

    renderCategoryChart(data);

    renderRecent(data);

}


/* GRÁFICO MENSAL */

function renderIncomeExpenseChart(data) {
    const totals = {
        income: data
            .filter(transaction => transaction.type === "income")
            .reduce((sum, transaction) => sum + transaction.value, 0),
        expense: data
            .filter(transaction => transaction.type === "expense")
            .reduce((sum, transaction) => sum + transaction.value, 0)
    };

    const total = totals.income + totals.expense;
    if (!total) {
        $("income-expense-chart").innerHTML =
            '<div class="empty">Nenhum lançamento neste período.</div>';
        return;
    }

    const incomePercentage = (totals.income / total) * 100;
    const gradient = `#16a34a 0% ${incomePercentage}%, #dc2626 ${incomePercentage}% 100%`;
    const items = [
        { label: "Receitas", value: totals.income, color: "#16a34a" },
        { label: "Despesas", value: totals.expense, color: "#dc2626" }
    ];

    $("income-expense-chart").innerHTML = `
        <div class="donut-container">
            <div class="donut" style="background: conic-gradient(${gradient})">
                <div class="donut-center">
                    <strong>${money(total)}</strong>
                    <span>Movimentado</span>
                </div>
            </div>
            <div class="donut-legend">
                ${items.map(item => `
                    <div class="legend-item">
                        <div class="legend-name">
                            <span class="legend-color" style="background:${item.color}"></span>
                            <span>${item.label}</span>
                        </div>
                        <div class="legend-value">
                            ${money(item.value)}
                            <small>${((item.value / total) * 100).toFixed(1)}%</small>
                        </div>
                    </div>
                `).join("")}
            </div>
        </div>`;
}

function renderMonthlyChart() {

    const months = [];

    const now = new Date();


    for (
        let i = 5;
        i >= 0;
        i--
    ) {

        const date =
            new Date(
                now.getFullYear(),
                now.getMonth() - i,
                1
            );


        months.push({

            key:
                `${date.getFullYear()}-${String(
                    date.getMonth() + 1
                ).padStart(2, "0")}`,

            label:
                date
                    .toLocaleDateString(
                        "pt-BR",
                        {
                            month: "short"
                        }
                    )
                    .replace(".", "")

        });

    }


    const values =
        months.map(month => {

            const list =
                transactions.filter(
                    transaction =>
                        transaction.date
                            .startsWith(month.key)
                );


            return {

                ...month,

                income:
                    list
                        .filter(
                            t =>
                                t.type === "income"
                        )
                        .reduce(
                            (sum, t) =>
                                sum + t.value,
                            0
                        ),

                expense:
                    list
                        .filter(
                            t =>
                                t.type === "expense"
                        )
                        .reduce(
                            (sum, t) =>
                                sum + t.value,
                            0
                        )

            };

        });


    const max =
        Math.max(
            1,
            ...values.flatMap(
                value => [
                    value.income,
                    value.expense
                ]
            )
        );


    $("monthly-chart").innerHTML =
        values
            .map(value => `

                <div class="month-column">

                    <div
                        class="bar income"
                        title="Receitas: ${money(
                            value.income
                        )}"
                        style="
                            height:
                            ${Math.max(
                                2,
                                value.income /
                                max * 190
                            )}px
                        ">
                    </div>

                    <div
                        class="bar expense"
                        title="Despesas: ${money(
                            value.expense
                        )}"
                        style="
                            height:
                            ${Math.max(
                                2,
                                value.expense /
                                max * 190
                            )}px
                        ">
                    </div>

                    <span class="month-label">
                        ${value.label}
                    </span>

                </div>

            `)
            .join("");

}


/* GRÁFICO DONUT POR CATEGORIA */

function renderCategoryChart(data) {

    const expenses =
        data.filter(
            transaction =>
                transaction.type === "expense"
        );


    const grouped = {};


    expenses.forEach(transaction => {
        const metadata = getAllocationMetadata(transaction.note);
        const categoryItems = metadata?.mode === "split"
            ? metadata.items
            : [{ category: transaction.category, value: transaction.value }];

        categoryItems.forEach(item => {
            grouped[item.category] = (grouped[item.category] || 0) + Number(item.value);
        });
    });


    const list =
        Object.entries(grouped)
            .sort(
                (a, b) =>
                    b[1] - a[1]
            );


    if (!list.length) {

        $("category-chart").innerHTML = `
            <div class="empty">
                Nenhuma despesa registrada.
            </div>
        `;

        return;

    }


    const total =
        list.reduce(
            (sum, item) =>
                sum + item[1],
            0
        );


    /* CORES DO DONUT */

    const colors = [

        "#2563eb",
        "#16a34a",
        "#f59e0b",
        "#dc2626",
        "#9333ea",
        "#0891b2",
        "#475569",
        "#ea580c",
        "#db2777"

    ];


    /* MONTA AS FATIAS */

    let current = 0;


    const slices =
        list.map(
            ([category, value], index) => {

                const percentage =
                    (value / total) * 100;


                const start =
                    current;


                current += percentage;


                return `
                    ${colors[index % colors.length]}
                    ${start}%
                    ${current}%
                `;

            }
        );


    const gradient =
        slices.join(", ");


    /* MONTA O GRÁFICO */

    $("category-chart").innerHTML = `

        <div class="donut-container">


            <!-- DONUT -->

            <div
                class="donut"
                style="
                    background:
                    conic-gradient(
                        ${gradient}
                    );
                "
            >

                <div class="donut-center">

                    <strong>
                        ${money(total)}
                    </strong>

                    <span>
                        Total
                    </span>

                </div>

            </div>


            <!-- LEGENDA -->

            <div class="donut-legend">

                ${list.map(
                    ([category, value], index) => {

                        const percentage =
                            (value / total) * 100;


                        return `

                            <div class="legend-item">

                                <div class="legend-name">

                                    <span
                                        class="legend-color"
                                        style="
                                            background:
                                            ${colors[index % colors.length]};
                                        ">
                                    </span>

                                    <span>
                                        ${category}
                                    </span>

                                </div>


                                <div class="legend-value">

                                    ${money(value)}

                                    <small>
                                        ${percentage.toFixed(1)}%
                                    </small>

                                </div>

                            </div>

                        `;

                    }
                ).join("")}

            </div>

        </div>

    `;

}


/* ÚLTIMOS LANÇAMENTOS */

function renderRecent(data) {

    const list =
        [...data]
            .sort(
                (a, b) =>
                    b.date.localeCompare(a.date)
            )
            .slice(0, 6);


    if (!list.length) {

        $("recent-list").innerHTML = `
            <div class="empty">
                Nenhum lançamento neste período.
            </div>
        `;

        return;

    }


    $("recent-list").innerHTML =
        list
            .map(transactionHTML)
            .join("");

}


function transactionHTML(transaction) {

    return `

        <div class="transaction-row">

            <span class="muted">
                ${
                    new Date(
                        transaction.date +
                        "T12:00:00"
                    )
                    .toLocaleDateString(
                        "pt-BR"
                    )
                }
            </span>


            <span class="transaction-description">
                ${escapeHTML(transaction.description)}
                ${transactionAllocationLabel(transaction) ? `<br><small>${escapeHTML(transactionAllocationLabel(transaction))}</small>` : ""}
            </span>


            <span class="muted">
                ${escapeHTML(transactionCategoryLabel(transaction))}
            </span>


            <span
                class="${
                    transaction.type
                }-text">

                ${
                    transaction.type === "income"
                    ? "Receita"
                    : "Despesa"
                }

            </span>


            <span
                class="${
                    transaction.type
                }-text">

                ${
                    transaction.type === "income"
                    ? "+"
                    : "−"
                }

                ${money(transaction.value)}

            </span>


            <button
                class="delete-button"
                onclick="
                    removeTransaction(
                        '${transaction.id}'
                    )
                ">

                ×

            </button>

        </div>

    `;

}


/* TABELA */

function transactionsInPeriod(items, prefix) {
    const start = $(`${prefix}-period-start`).value;
    const end = $(`${prefix}-period-end`).value;
    const error = $(`${prefix}-period-error`);

    if (start && end && start > end) {
        if (error) error.textContent = "O início do período deve ser anterior ao fim.";
        return [];
    }
    if (error) error.textContent = "";

    return items.filter(transaction => {
        const month = String(transaction.date || "").slice(0, 7);
        return (!start || month >= start) && (!end || month <= end);
    });
}

function renderTable() {

    const list =
        transactionsInPeriod(transactions, "launch")
            .sort(
                (a, b) =>
                    b.date.localeCompare(a.date)
            );


    if (!list.length) {

        $("transactions-table").innerHTML = `
            <tr>
                <td colspan="6">
                    <div class="empty">
                        Nenhum lançamento encontrado neste período.
                    </div>
                </td>
            </tr>
        `;

        return;

    }


    $("transactions-table").innerHTML =
        list
            .map(
                transaction => `

                <tr>

                    <td>

                        ${
                            new Date(
                                transaction.date +
                                "T12:00:00"
                            )
                            .toLocaleDateString(
                                "pt-BR"
                            )
                        }

                    </td>


                    <td>

                        <strong>
                            ${
                                escapeHTML(transaction.description)
                            }
                        </strong>
                        ${installmentLabel(transaction) ? `<br><small class="fixed-label">${escapeHTML(installmentLabel(transaction))}</small>` : transactionAllocationLabel(transaction) ? `<br><small class="fixed-label">${escapeHTML(transactionAllocationLabel(transaction))}</small>` : transaction.is_fixed ? '<br><small class="fixed-label">Fixo mensal</small>' : ""}
                        ${renderAllocationDetailsHTML(transaction)}

                    </td>


                    <td>

                        ${
                            escapeHTML(transactionCategoryLabel(transaction))
                        }

                    </td>


                    <td>

                        <span
                            class="
                                badge
                                ${
                                    transaction.type
                                }
                            ">

                            ${
                                transaction.type ===
                                "income"
                                ?
                                "Receita"
                                :
                                "Despesa"
                            }

                        </span>

                    </td>


                    <td
                        class="
                            ${
                                transaction.type
                            }-text
                        ">

                        ${
                            transaction.type ===
                            "income"
                            ?
                            "+"
                            :
                            "−"
                        }

                        ${money(transaction.value)}

                    </td>


                    <td>

                        <button
                            type="button"
                            class="edit-transaction-button"
                            data-edit-transaction="${transaction.id}">
                            Editar
                        </button>

                        <button
                            class="delete-button"
                            onclick="
                                removeTransaction(
                                    '${transaction.id}'
                                )
                            ">

                            ×

                        </button>

                    </td>

                </tr>

            `
            )
            .join("");

}


/* CATEGORIAS */

function renderCategories() {
    const allCategories = [
        ...categories.income.map(name => ({ name, type: "income" })),
        ...categories.expense.map(name => ({ name, type: "expense" }))
    ];

    if (!allCategories.length) {
        $("categories-grid").innerHTML = '<div class="empty">Nenhuma categoria cadastrada.</div>';
        return;
    }

    $("categories-grid").innerHTML = allCategories.map(category => {
        const count = transactions.filter(t => t.category === category.name).length;
        const typeLabel = category.type === "income" ? "Receita" : "Despesa";
        const safeName = escapeHTML(category.name);

        return `
            <div class="category-card">
                <div class="category-info">
                    <strong>${safeName}</strong>
                    <span>${typeLabel} · ${count} lançamento(s)</span>
                </div>
                <div class="category-actions">
                    <button class="edit-category-button" data-action="edit" data-name="${safeName}" data-type="${category.type}">Editar</button>
                    <button class="delete-button" data-action="delete" data-name="${safeName}" data-type="${category.type}" aria-label="Excluir ${safeName}">×</button>
                </div>
            </div>`;
    }).join("");
}

function escapeHTML(text) {
    return String(text).replace(/[&<>"']/g, char => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
}

let editingCategory = null;

function openCategoryModal(category = null) {
    editingCategory = category;
    $("category-form").reset();
    $("category-modal-title").textContent = category ? "Editar categoria" : "Nova categoria";
    if (category) {
        $("category-name").value = category.name;
        $("category-type").value = category.type;
    }
    $("category-modal").classList.remove("hidden");
    $("category-name").focus();
}

function closeCategoryModal() {
    $("category-modal").classList.add("hidden");
}

async function saveCategory(event) {
    event.preventDefault();
    const name = $("category-name").value.trim();
    const type = $("category-type").value;
    if (!name) return;

    const exists = ["income", "expense"].some(categoryType =>
        categories[categoryType].some(existing =>
            existing.toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR") &&
            !(editingCategory && editingCategory.type === categoryType && editingCategory.name === existing)
        )
    );
    if (exists) {
        alert("Já existe uma categoria com esse nome.");
        return;
    }

    const oldCategory = editingCategory;
    const previousCategories = JSON.parse(JSON.stringify(categories));
    const previousTransactions = transactions.map(transaction => ({ ...transaction }));

    if (editingCategory) {
        const { name: oldName, type: oldType } = editingCategory;
        categories[oldType] = categories[oldType].filter(item => item !== oldName);
        categories[type].push(name);
        transactions.forEach(transaction => {
            if (transaction.category === oldName) transaction.category = name;
        });
    } else {
        categories[type].push(name);
    }

    try {
        await upsertCloudCategories([
            ...categories.income.map(categoryName => ({ name: categoryName, type: "income" })),
            ...categories.expense.map(categoryName => ({ name: categoryName, type: "expense" }))
        ]);
        if (oldCategory) {
            await syncAllTransactionsToCloud();
            await deleteCloudCategory(oldCategory.name);
        }
    } catch (error) {
        categories = previousCategories;
        transactions = previousTransactions;
        save();
        alert(`Não foi possível salvar a categoria no Supabase: ${error.message}`);
        return;
    }

    saveCategories();
    save();
    closeCategoryModal();
    updateCategoryOptions();

    renderAll();
}

async function deleteCategory(name, type) {
    if (transactions.some(transaction => transaction.category === name)) {
        alert("Essa categoria está sendo usada em lançamentos. Edite esses lançamentos antes de excluí-la.");
        return;
    }
    if (!confirm(`Excluir a categoria "${name}"?`)) return;
    try {
        await deleteCloudCategory(name);
    } catch (error) {
        alert(`Não foi possível excluir a categoria no Supabase: ${error.message}`);
        return;
    }
    categories[type] = categories[type].filter(item => item !== name);
    saveCategories();
    updateCategoryOptions();
    renderAll();
}


/* EXCLUIR */

async function removeTransaction(id) {

    try {
        await deleteCloudTransaction(id);
    } catch (error) {
        alert(`Não foi possível excluir o lançamento no Supabase: ${error.message}`);
        return;
    }

    transactions =
        transactions.filter(
            transaction =>
                transaction.id !== id
        );


    save();

    renderAll();

}


/* RENDERIZA TUDO */

function renderAll() {

    renderDashboard();

    renderTable();

    renderCategories();

    renderCashflow();

}

function renderCashflow() {
    const ordered = transactionsInPeriod(transactions, "cashflow").sort((a, b) =>
        (a.type === "income" ? 0 : 1) - (b.type === "income" ? 0 : 1) ||
        a.date.localeCompare(b.date) || (a.id || "").localeCompare(b.id || "")
    );

    const confirmedBalance = ordered.reduce((balance, transaction) => {
        if (transaction.status === "pending") return balance;
        return balance + (transaction.type === "income" ? transaction.value : -transaction.value);
    }, 0);

    const pendingCount = ordered.filter(transaction => transaction.status === "pending").length;
    const forecastBalance = ordered.reduce((balance, transaction) =>
        balance + (transaction.type === "income" ? transaction.value : -transaction.value), 0
    );

    $("cashflow-confirmed").textContent = money(confirmedBalance);
    $("cashflow-forecast").textContent = money(forecastBalance);
    $("cashflow-pending").textContent = pendingCount;

    if (!ordered.length) {
        $("cashflow-table").innerHTML = `
            <tr><td colspan="7"><div class="empty">Nenhum lançamento encontrado neste período.</div></td></tr>`;
        renderMonthlyProjection();
        return;
    }

    let runningBalance = 0;
    $("cashflow-table").innerHTML = ordered.map(transaction => {
        const signedValue = transaction.type === "income" ? transaction.value : -transaction.value;
        runningBalance += signedValue;
        if (selectedCashflowFilter !== "all" && transaction.type !== selectedCashflowFilter) return "";
        const isConfirmed = transaction.status !== "pending";
        const statusLabel = isConfirmed
            ? (transaction.type === "income" ? "Recebido" : "Pago")
            : "Pendente";
        const actionLabel = isConfirmed
            ? "Reabrir"
            : (transaction.type === "income" ? "Confirmar recebimento" : "Confirmar pagamento");

        return `
            <tr>
                <td>${new Date(transaction.date + "T12:00:00").toLocaleDateString("pt-BR")}</td>
                <td><strong>${escapeHTML(transaction.description)}</strong>${installmentLabel(transaction) ? `<br><small class="fixed-label">${escapeHTML(installmentLabel(transaction))}</small>` : transactionAllocationLabel(transaction) ? `<br><small class="fixed-label">${escapeHTML(transactionAllocationLabel(transaction))}</small>${renderAllocationDetailsHTML(transaction)}` : transaction.is_fixed ? '<br><small class="fixed-label">Fixo mensal</small>' : ""}</td>
                <td>${escapeHTML(transactionCategoryLabel(transaction))}</td>
                <td class="${transaction.type}-text">${transaction.type === "income" ? "+" : "−"}${money(transaction.value)}</td>
                <td><span class="status-badge ${isConfirmed ? "confirmed" : "pending"}">${statusLabel}</span></td>
                <td class="${runningBalance < 0 ? "expense-text" : "income-text"}">${money(runningBalance)}</td>
                <td class="cashflow-actions">${installmentLabel(transaction) ? `<button class="edit-transaction-button" type="button" data-edit-transaction="${transaction.id}">Editar parcela</button>` : ""}<button class="cashflow-action" data-transaction-id="${transaction.id}">${actionLabel}</button></td>
            </tr>`;
    }).join("") || `<tr><td colspan="7"><div class="empty">Nenhum lançamento neste filtro.</div></td></tr>`;
    renderMonthlyProjection();
}

function monthKeyFromOffset(baseMonth, offset) {
    const [year, month] = baseMonth.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1 + offset, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(monthKey) {
    const [year, month] = monthKey.split("-").map(Number);
    return new Date(year, month - 1, 1).toLocaleDateString("pt-BR", {
        month: "long",
        year: "numeric"
    });
}

function renderMonthlyProjection() {
    const table = $("monthly-projection-table");
    if (!table) return;

    const currentMonthKey = currentMonth();
    const monthCount = Number($("projection-months").value) || 12;
    let projectedBalance = transactions.reduce((balance, transaction) => {
        const transactionMonth = transaction.date.slice(0, 7);
        if (transactionMonth > currentMonthKey) return balance;
        const value = Number(transaction.value);
        const signedValue = transaction.type === "income" ? value : -value;
        if (!transaction.is_fixed || transactionMonth === currentMonthKey) return balance + signedValue;

        const [startYear, startMonth] = transactionMonth.split("-").map(Number);
        const [currentYear, currentMonthNumber] = currentMonthKey.split("-").map(Number);
        const elapsedMonths = (currentYear - startYear) * 12 + currentMonthNumber - startMonth;
        return balance + signedValue * (elapsedMonths + 1);
    }, 0);

    const rows = [];
    for (let offset = 1; offset <= monthCount; offset += 1) {
        const targetMonth = monthKeyFromOffset(currentMonthKey, offset);
        let income = 0;
        let expense = 0;
        const installmentIncome = [];
        const installmentExpense = [];

        transactions.forEach(transaction => {
            const transactionMonth = transaction.date.slice(0, 7);
            const isScheduledThisMonth = transactionMonth === targetMonth;
            const isRecurringOccurrence = Boolean(transaction.is_fixed) && transactionMonth < targetMonth;
            if (!isScheduledThisMonth && !isRecurringOccurrence) return;

            if (transaction.type === "income") income += Number(transaction.value);
            else expense += Number(transaction.value);

            const installment = getInstallmentMetadata(transaction.note);
            if (installment && isScheduledThisMonth) {
                const detail = `<span>${escapeHTML(transaction.description)} · ${escapeHTML(installmentLabel(transaction))} · ${transaction.status === "pending" ? "Pendente" : transaction.type === "income" ? "Recebida" : "Paga"}: ${money(Number(transaction.value))}</span>`;
                (transaction.type === "income" ? installmentIncome : installmentExpense).push(detail);
            }
        });

        projectedBalance += income - expense;
        rows.push(`
            <tr>
                <td class="projection-month-name">${monthLabel(targetMonth)}</td>
                <td class="income-text">${money(income)}${installmentIncome.length ? `<div class="projection-installments">${installmentIncome.join("")}</div>` : ""}</td>
                <td class="expense-text">${money(expense)}${installmentExpense.length ? `<div class="projection-installments">${installmentExpense.join("")}</div>` : ""}</td>
                <td class="${projectedBalance < 0 ? "expense-text" : "income-text"}"><strong>${money(projectedBalance)}</strong></td>
            </tr>`);
    }

    table.innerHTML = rows.join("");
}


/* NAVEGAÇÃO */

function switchSection(section) {

    document
        .querySelectorAll(".section")
        .forEach(element => {

            element
                .classList
                .remove(
                    "active-section"
                );

        });


    $(section)
        .classList
        .add("active-section");


    document
        .querySelectorAll(".menu-item")
        .forEach(button => {

            button.classList.toggle(
                "active",
                button.dataset.section ===
                section
            );

        });


    if (section === "dashboard") {

        $("page-title").textContent =
            "Dashboard";

    }

    else if (
        section === "lancamentos"
    ) {

        $("page-title").textContent =
            "Lançamentos";

    }

    else if (section === "fluxo-caixa") {

        $("page-title").textContent =
            "Fluxo de caixa";

    }

    else {

        $("page-title").textContent =
            "Categorias";

    }

}


/* EVENTOS */

$("new-allocation").addEventListener("click", () => openAllocationModal());
$("close-allocation-modal").addEventListener("click", closeAllocationModal);
$("allocation-modal").addEventListener("click", event => {
    if (event.target === $("allocation-modal")) closeAllocationModal();
});
$("allocation-mode-split").addEventListener("click", () => setAllocationMode("split"));
$("allocation-mode-aggregate").addEventListener("click", () => setAllocationMode("aggregate"));
$("allocation-add-line").addEventListener("click", appendAllocationLine);
$("allocation-form").addEventListener("submit", saveAllocation);
$("allocation-total").addEventListener("input", event => {
    const digits = event.target.value.replace(/\D/g, "");
    event.target.value = digits ? money(Number(digits) / 100) : "";
    updateAllocationSummary();
});
$("allocation-lines").addEventListener("input", event => {
    if (!event.target.matches(".allocation-line-value")) return;
    const digits = event.target.value.replace(/\D/g, "");
    event.target.value = digits ? money(Number(digits) / 100) : "";
    updateAllocationSummary();
});
$("allocation-lines").addEventListener("click", event => {
    const button = event.target.closest(".remove-allocation-line");
    if (!button) return;
    if ($("allocation-lines").children.length === 1) {
        alert("Mantenha pelo menos um item no rateio.");
        return;
    }
    button.closest(".allocation-line").remove();
    updateAllocationSummary();
});

$("cashflow-filters").addEventListener("click", event => {
    const button = event.target.closest("[data-cashflow-filter]");
    if (!button) return;

    selectedCashflowFilter = button.dataset.cashflowFilter;
    $("cashflow-filters").querySelectorAll("[data-cashflow-filter]").forEach(filterButton => {
        const isSelected = filterButton === button;
        filterButton.classList.toggle("active", isSelected);
        filterButton.setAttribute("aria-pressed", String(isSelected));
    });
    renderCashflow();
});

function resetPeriodToCurrent(prefix) {
    const month = currentMonth();
    $(`${prefix}-period-start`).value = month;
    $(`${prefix}-period-end`).value = month;
    if (prefix === "launch") renderTable();
    else renderCashflow();
}

["launch", "cashflow"].forEach(prefix => {
    $(`${prefix}-period-start`).addEventListener("change", () => {
        if (prefix === "launch") renderTable();
        else renderCashflow();
    });
    $(`${prefix}-period-end`).addEventListener("change", () => {
        if (prefix === "launch") renderTable();
        else renderCashflow();
    });
    $(`${prefix}-period-current`).addEventListener("click", () => resetPeriodToCurrent(prefix));
});

$("transactions-table").addEventListener("click", event => {
    const editButton = event.target.closest("button[data-edit-transaction]");
    if (!editButton) return;
    const transactionId = editButton.dataset.editTransaction;
    const transaction = transactions.find(item => String(item.id) === transactionId);
    if (!transaction) {
        alert("Esse lançamento não foi encontrado. Atualize a página e tente novamente.");
        return;
    }
    if (getAllocationMetadata(transaction.note)) {
        openAllocationModal(transaction);
    } else {
        openModal(transaction);
    }
});

$("value").addEventListener("input", event => {
    const digits = event.target.value.replace(/\D/g, "");
    event.target.value = digits ? money(Number(digits) / 100) : "";
});

$("cashflow-table").addEventListener("click", async event => {
    const editButton = event.target.closest("button[data-edit-transaction]");
    if (editButton) {
        const editTransaction = transactions.find(item => String(item.id) === editButton.dataset.editTransaction);
        if (!editTransaction) return;
        if (getAllocationMetadata(editTransaction.note)) openAllocationModal(editTransaction);
        else openModal(editTransaction);
        return;
    }

    const button = event.target.closest("[data-transaction-id]");
    if (!button) return;
    const transaction = transactions.find(item => item.id === button.dataset.transactionId);
    if (!transaction) return;
    const previousStatus = transaction.status;
    transaction.status = transaction.status === "pending" ? "confirmed" : "pending";
    try {
        await upsertCloudTransaction(transaction);
    } catch (error) {
        transaction.status = previousStatus;
        alert(`Não foi possível atualizar no Supabase: ${error.message}`);
        return;
    }
    save();
    renderAll();
});

$("new-category").addEventListener("click", () => openCategoryModal());
$("close-category-modal").addEventListener("click", closeCategoryModal);
$("category-modal").addEventListener("click", event => {
    if (event.target === $("category-modal")) closeCategoryModal();
});
$("category-form").addEventListener("submit", saveCategory);
$("categories-grid").addEventListener("click", event => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const { action, name, type } = button.dataset;
    if (action === "edit") openCategoryModal({ name, type });
    if (action === "delete") deleteCategory(name, type);
});

$("auth-sign-in").addEventListener("click", () => authenticate("signin"));
$("auth-sign-up").addEventListener("click", () => authenticate("signup"));
$("auth-form").addEventListener("submit", event => {
    event.preventDefault();
    authenticate("signin");
});

$("sign-out").addEventListener("click", async () => {
    if (!supabaseClient) return;
    const { error } = await supabaseClient.auth.signOut();
    if (error) alert(`Não foi possível sair: ${error.message}`);
});

document
    .querySelectorAll(".menu-item")
    .forEach(button => {

        button.addEventListener(
            "click",
            () =>
                switchSection(
                    button.dataset.section
                )
        );

    });


document
    .querySelectorAll("[data-go]")
    .forEach(button => {

        button.addEventListener(
            "click",
            () =>
                switchSection(
                    button.dataset.go
                )
        );

    });


$("new-launch-2")
    .addEventListener(
        "click",
        () => openModal()
    );

$("transaction-installments").addEventListener("change", event => {
    const enabled = event.target.checked;
    $("installment-count-field").classList.toggle("hidden", !enabled);
    if (enabled) $("transaction-fixed").checked = false;
    updateInstallmentPreview();
});

function updateInstallmentPreview() {
    const count = Number($("installment-count").value);
    const total = parseCurrencyInput($("value").value);
    const baseDate = $("date").value;
    const preview = $("installment-preview");
    if (!total || !Number.isInteger(count) || count < 2 || count > 60 || !baseDate) {
        preview.textContent = "Informe o valor total, a data e a quantidade de parcelas.";
        return;
    }

    const totalCents = Math.round(total * 100);
    const baseCents = Math.floor(totalCents / count);
    const extraCents = totalCents % count;
    const schedule = Array.from({ length: count }, (_, index) => {
        const value = (baseCents + (index < extraCents ? 1 : 0)) / 100;
        const date = new Date(`${installmentDate(baseDate, index)}T12:00:00`)
            .toLocaleDateString("pt-BR");
        return `<li><span>Parcela ${index + 1}/${count}</span><strong>${date} · ${money(value)}</strong></li>`;
    }).join("");
    preview.innerHTML = `<p>Primeira parcela no mês informado; as seguintes nos meses subsequentes:</p><ul>${schedule}</ul>`;
}

$("installment-count").addEventListener("input", updateInstallmentPreview);
$("value").addEventListener("input", updateInstallmentPreview);
$("date").addEventListener("change", updateInstallmentPreview);
$("transaction-fixed").addEventListener("change", event => {
    if (!event.target.checked) return;
    $("transaction-installments").checked = false;
    $("installment-count-field").classList.add("hidden");
});


$("close-modal")
    .addEventListener(
        "click",
        closeModal
    );


$("modal")
    .addEventListener(
        "click",
        event => {

            if (
                event.target ===
                $("modal")
            ) {

                closeModal();

            }

        }
    );


$("month-filter").value =
    currentMonth();


$("month-filter")
    .addEventListener(
        "change",
        renderDashboard
    );


$("clear-filter")
    .addEventListener(
        "click",
        () => {

            $("month-filter").value = "";

            renderDashboard();

        }
    );


document
    .querySelectorAll(
        'input[name="type"]'
    )
    .forEach(radio => {

        radio.addEventListener(
            "change",
            updateCategoryOptions
        );

    });


/* SALVAR LANÇAMENTO */

$("transaction-form")
    .addEventListener(
        "submit",
        async event => {

            event.preventDefault();


            const type =
                document
                    .querySelector(
                        'input[name="type"]:checked'
                    )
                    .value;

            const numericValue = parseCurrencyInput($("value").value);
            if (numericValue <= 0) {
                alert("Informe um valor maior que zero.");
                return;
            }

            const previousTransaction = editingTransactionId
                ? transactions.find(item => item.id === editingTransactionId)
                : null;
            const allocationMetadata = getAllocationMetadata(previousTransaction?.note);
            const installmentMetadata = getInstallmentMetadata(previousTransaction?.note);
            if (allocationMetadata && Math.abs(Number(previousTransaction.value) - numericValue) >= 0.01) {
                alert("Este lançamento tem um rateio detalhado. Para manter a soma dos itens correta, exclua e refaça o rateio com o novo total.");
                return;
            }
            const transactionNote = allocationMetadata
                ? composeAllocationNote($("note").value, allocationMetadata)
                : installmentMetadata
                    ? composeInstallmentNote($("note").value, installmentMetadata)
                : $("note").value.trim();


            const transaction = {

                id: editingTransactionId || crypto.randomUUID(),

                description:
                    $("description")
                    .value
                    .trim(),

                value: numericValue,

                date:
                    $("date").value,

                category:
                    $("category").value,

                type,

                note:
                    transactionNote,

                status:
                    $("transaction-status").value,

                is_fixed:
                    $("transaction-fixed").checked

            };

            let transactionsToSave = [transaction];
            const shouldInstallment = !editingTransactionId && $("transaction-installments").checked;
            if (shouldInstallment) {
                const count = Number($("installment-count").value);
                if (!Number.isInteger(count) || count < 2 || count > 60) {
                    alert("Escolha uma quantidade de 2 a 60 parcelas.");
                    return;
                }
                const groupId = crypto.randomUUID();
                const totalCents = Math.round(numericValue * 100);
                const baseCents = Math.floor(totalCents / count);
                const extraCents = totalCents % count;
                transactionsToSave = Array.from({ length: count }, (_, index) => {
                    const metadata = { groupId, index: index + 1, count, total: numericValue };
                    return {
                        ...transaction,
                        id: crypto.randomUUID(),
                        value: (baseCents + (index < extraCents ? 1 : 0)) / 100,
                        date: installmentDate(transaction.date, index),
                        is_fixed: false,
                        note: composeInstallmentNote(transaction.note, metadata)
                    };
                });
            }

            try {
                if (shouldInstallment) await upsertCloudTransactions(transactionsToSave);
                else await upsertCloudTransaction(transaction);
            } catch (error) {
                alert(`Não foi possível salvar no Supabase: ${error.message}`);
                return;
            }


            if (editingTransactionId) {
                transactions = transactions.map(item =>
                    item.id === editingTransactionId ? transaction : item
                );
            } else {
                transactions.push(...transactionsToSave);
            }


            save();

            closeModal();

            renderAll();

        }
    );


/* INICIALIZAÇÃO */

$("date").value =
    today();


updateCategoryOptions();

const initialPeriod = currentMonth();
["launch", "cashflow"].forEach(prefix => {
    $(`${prefix}-period-start`).value = initialPeriod;
    $(`${prefix}-period-end`).value = initialPeriod;
});

$("projection-months").addEventListener("change", renderMonthlyProjection);

renderAll();

initializeSupabase();

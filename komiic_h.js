class Komiic extends ComicSource {
  // 此漫画源的名称
  name = "KomiicH";

  // 唯一标识符
  key = "KomiicH";

  version = "1.2.1";

  minAppVersion = "1.0.0";

  // 更新链接
  url = "https://cdn.jsdelivr.net/gh/miludeshiji/venera-configs@main/komiic_h.js";

  // 可选访问域名，默认主站
  get baseUrl() {
    return this.loadSetting("domain") || "https://h.komiic.com";
  }

  loadSharedData(dataKey) {
    if (typeof sendMessage === "function") {
      return sendMessage({
        method: "load_data",
        key: "Komiic",
        data_key: dataKey,
      });
    }
    return null;
  }

  saveSharedData(dataKey, data) {
    if (typeof sendMessage === "function") {
      return sendMessage({
        method: "save_data",
        key: "Komiic",
        data_key: dataKey,
        data: data,
      });
    }
    throw "sendMessage is not available";
  }

  deleteSharedData(dataKey) {
    if (typeof sendMessage === "function") {
      return sendMessage({
        method: "delete_data",
        key: "Komiic",
        data_key: dataKey,
      });
    }
    return null;
  }

  isValidToken(token) {
    return typeof token === "string" && token.trim().length > 0;
  }

  validateCredentials(raw) {
    if (Array.isArray(raw) && raw.length >= 2) {
      const user = typeof raw[0] === "string" ? raw[0].trim() : "";
      const pass = typeof raw[1] === "string" ? raw[1] : "";
      if (user.length > 0 && pass.length > 0) {
        return [user, pass];
      }
    } else if (raw && typeof raw === "object") {
      const user =
        typeof (raw.account || raw.email || raw.username) === "string"
          ? (raw.account || raw.email || raw.username).trim()
          : "";
      const pass =
        typeof (raw.pwd || raw.password) === "string"
          ? (raw.pwd || raw.password)
          : "";
      if (user.length > 0 && pass.length > 0) {
        return [user, pass];
      }
    }
    return null;
  }

  isValidAccount(account) {
    return this.validateCredentials(account) !== null;
  }

  loadAuthData(field) {
    if (field !== "token" && field !== "account") {
      return null;
    }

    // 1. Prefer shared owner storage (Komiic)
    let sharedVal = null;
    try {
      sharedVal = this.loadSharedData(field);
    } catch (e) {
      sharedVal = null;
    }
    const isSharedValid =
      field === "token"
        ? this.isValidToken(sharedVal)
        : this.isValidAccount(sharedVal);
    if (isSharedValid) {
      return sharedVal;
    }

    // 2. Fall back to local legacy storage
    let localVal = null;
    try {
      localVal = this.loadData(field);
    } catch (e) {
      localVal = null;
    }
    const isLocalValid =
      field === "token"
        ? this.isValidToken(localVal)
        : this.isValidAccount(localVal);
    if (isLocalValid) {
      // Idempotent migration: copy valid local auth to shared storage
      try {
        this.saveSharedData(field, localVal);
      } catch (e) {}
      return localVal;
    }

    return null;
  }

  saveAuthData(token, accountData) {
    let savedShared = false;
    try {
      this.saveSharedData("token", token);
      this.saveSharedData("account", accountData);
      savedShared = true;
    } catch (e) {
      savedShared = false;
    }

    let savedLocal = false;
    if (!savedShared) {
      try {
        this.saveData("token", token);
        this.saveData("account", accountData);
        savedLocal = true;
      } catch (e) {
        savedLocal = false;
      }
    }

    if (!savedShared && !savedLocal) {
      throw "Failed to save login credentials";
    }
    return true;
  }

  clearAuthData() {
    // Clear shared owner data where possible
    try {
      this.deleteSharedData("token");
    } catch (e) {}
    try {
      this.deleteSharedData("account");
    } catch (e) {}

    // Clear local compatibility data
    try {
      this.deleteData("token");
    } catch (e) {}
    try {
      this.deleteData("account");
    } catch (e) {}
  }

  getAuthToken() {
    try {
      let token = this.loadAuthData("token");
      return this.isValidToken(token) ? token.trim() : null;
    } catch (e) {
      return null;
    }
  }

  getAccountCredentials() {
    try {
      let raw = this.loadAuthData("account");
      return this.validateCredentials(raw);
    } catch (e) {
      return null;
    }
  }

  get headers() {
    let token = this.getAuthToken();
    let headers = {
      Referer: this.baseUrl + "/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Content-Type": "application/json",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
  }

  normalizeCover(url) {
    if (!url || typeof url !== "string") {
      return url;
    }
    const base = (this.baseUrl || "https://h.komiic.com").trim().replace(/\/+$/, "");
    const baseMatch = base.match(/^(https?:)\/\/([^\/?#]+)/i);
    const protocol = baseMatch ? baseMatch[1] : "https:";
    const baseHost = baseMatch ? baseMatch[2] : "komiic.com";
    const baseDomain = baseHost.replace(/^.*?\bkomiic\./i, "komiic.");

    const komiicMatch = url.match(
      /^(?:https?:)?\/\/(?:([a-z0-9_.-]+)\.)?komiic\.(?:com|cc)(?::\d+)?([/?#].*|$)/i,
    );
    if (komiicMatch) {
      const sub = komiicMatch[1] ? `${komiicMatch[1]}.` : "";
      const rest = komiicMatch[2] || "";
      return `${protocol}//${sub}${baseDomain}${rest}`;
    }

    if (/^\/\//.test(url)) {
      return url;
    }

    if (/^[^/]*:/.test(url)) {
      return url;
    }

    return `${base}/${url.replace(/^(\.\/)+/, "").replace(/^\/+/, "")}`;
  }

  rememberTagTargets(info) {
    if (!info || typeof info !== "object") {
      return;
    }

    let targets;
    try {
      targets = this.loadData("tagTargetIdsV2");
    } catch (e) {
      targets = {};
    }

    if (typeof targets === "string") {
      try {
        targets = JSON.parse(targets);
      } catch (e) {
        targets = {};
      }
    }

    if (!targets || typeof targets !== "object" || Array.isArray(targets)) {
      targets = {};
    }

    let changed = false;

    const save = (namespace, name, type, id) => {
      if (
        typeof namespace !== "string" ||
        typeof name !== "string" ||
        typeof type !== "string" ||
        id === null ||
        id === undefined
      ) {
        return;
      }

      const normNamespace = namespace.trim();
      const normName = name.trim();
      const normType = type.trim();
      const idStr = String(id).trim();

      if (
        normNamespace.length === 0 ||
        normName.length === 0 ||
        normType.length === 0 ||
        idStr.length === 0
      ) {
        return;
      }

      const key = JSON.stringify([normNamespace, normName]);
      const current = targets[key];

      if (
        !current ||
        typeof current !== "object" ||
        Array.isArray(current) ||
        current.type !== normType ||
        current.id !== idStr
      ) {
        targets[key] = { type: normType, id: idStr };
        changed = true;
      }
    };

    if (Array.isArray(info.authors)) {
      info.authors.forEach((author) => {
        if (author && typeof author === "object") {
          save("作者", author.name, "author", author.id);
        }
      });
    }

    if (Array.isArray(info.categories)) {
      info.categories.forEach((category) => {
        if (category && typeof category === "object") {
          save("标签", category.name, "category", category.id);
        }
      });
    }

    if (changed) {
      try {
        this.saveData("tagTargetIdsV2", targets);
      } catch (e) {
        // ignore storage errors
      }
    }
  }

  getTagTarget(namespace, tag) {
    if (typeof namespace !== "string" || typeof tag !== "string") {
      return null;
    }

    const normNamespace = namespace.trim();
    const normTag = tag.trim();
    if (normNamespace.length === 0 || normTag.length === 0) {
      return null;
    }

    let targets;
    try {
      targets = this.loadData("tagTargetIdsV2");
    } catch (e) {
      return null;
    }

    if (typeof targets === "string") {
      try {
        targets = JSON.parse(targets);
      } catch (e) {
        return null;
      }
    }

    if (!targets || typeof targets !== "object" || Array.isArray(targets)) {
      return null;
    }

    const key = JSON.stringify([normNamespace, normTag]);
    const target = targets[key];
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      return null;
    }

    const type = typeof target.type === "string" ? target.type.trim() : "";
    const id =
      target.id !== null && target.id !== undefined
        ? String(target.id).trim()
        : "";
    if (type.length === 0 || id.length === 0) {
      return null;
    }

    if (type !== "author" && type !== "category") {
      return null;
    }

    return { type, id };
  }

  getTimeDifference(date) {
    if (!date || isNaN(date.getTime())) {
      return "";
    }
    const now = new Date();
    const timeDifference = now - date;

    const millisecondsPerHour = 1000 * 60 * 60;
    const millisecondsPerDay = millisecondsPerHour * 24;

    if (timeDifference < millisecondsPerHour) {
      return "剛剛更新";
    } else if (timeDifference < millisecondsPerDay) {
      const hours = Math.floor(timeDifference / millisecondsPerHour);
      return `${hours}小時前更新`;
    } else {
      const days = Math.floor(timeDifference / millisecondsPerDay);
      return `${days}天前更新`;
    }
  }

  parseComicCard(comic) {
    if (!comic || typeof comic !== "object") {
      return null;
    }

    let author = "";
    if (Array.isArray(comic.authors) && comic.authors.length > 0 && comic.authors[0]) {
      author = comic.authors[0].name || "";
    }
    let tags = [];
    if (Array.isArray(comic.categories)) {
      comic.categories.forEach((c) => {
        if (c && c.name) {
          tags.push(c.name);
        }
      });
    }

    let updateTime =
      comic.dateUpdated instanceof Date
        ? comic.dateUpdated
        : comic.dateUpdated
          ? new Date(comic.dateUpdated)
          : null;
    let description = updateTime ? this.getTimeDifference(updateTime) : "";
    let formatedTime =
      updateTime && !isNaN(updateTime.getTime())
        ? `${updateTime.getFullYear()}-${updateTime.getMonth() + 1}-${updateTime.getDate()}`
        : "";

    return {
      id: comic.id,
      title: comic.title,
      subTitle: author,
      cover: this.normalizeCover(comic.imageUrl),
      tags: tags,
      description: description,
      intro: comic.description || "",
      updateTime: formatedTime,
    };
  }

  async queryJson(query, isRetry = false) {
    let res = await Network.post(
      this.baseUrl + "/api/query",
      this.headers,
      query,
    );

    if (res.status !== 200) {
      throw `Invalid Status Code ${res.status}`;
    }

    let json = JSON.parse(res.body);

    if (json.errors != undefined) {
      const errorInfo =
        json.errors[0] && json.errors[0].message != null
          ? json.errors[0].message.toString()
          : "";
      if (
        !isRetry &&
        (errorInfo.indexOf("token is expired") >= 0 ||
          errorInfo.indexOf("no token") >= 0)
      ) {
        const credentials = this.getAccountCredentials();
        if (credentials) {
          await this.account.login(credentials[0], credentials[1]);
          return await this.queryJson(query, true);
        }
      }
      throw json.errors[0].message;
    }

    return json;
  }

  async queryComics(query) {
    let operationName = query["operationName"];
    let json = await this.queryJson(query);

    let rawList = (json && json.data && json.data[operationName]) || [];
    let comics = Array.isArray(rawList)
      ? rawList.map((comic) => this.parseComicCard(comic)).filter(Boolean)
      : [];

    return {
      comics: comics,
      // 没找到最大页数的接口
      maxPage: null,
    };
  }

  async queryAuthorComics(authorId, options, page) {
    let json = await this.queryJson({
      operationName: "getComicsByAuthor",
      variables: { authorId: authorId },
      query: `query getComicsByAuthor($authorId: ID!) {
        getComicsByAuthor(authorId: $authorId) {
          id
          title
          status
          year
          imageUrl
          authors {
            id
            name
            __typename
          }
          categories {
            id
            name
            __typename
          }
          dateUpdated
          monthViews
          views
          favoriteCount
          lastBookUpdate
          lastChapterUpdate
          __typename
        }
      }`,
    });

    let rawList = (json && json.data && json.data.getComicsByAuthor) || [];
    if (!Array.isArray(rawList)) {
      rawList = [];
    }

    let list = rawList.filter((c) => c && typeof c === "object");

    const statusFilter =
      options && typeof options[1] === "string" ? options[1].trim() : "";
    if (statusFilter.length > 0) {
      list = list.filter((c) => c.status === statusFilter);
    }

    const sortOption =
      options && typeof options[0] === "string" ? options[0].trim() : "DATE_UPDATED";
    if (sortOption === "VIEWS") {
      list.sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0));
    } else if (sortOption === "FAVORITE_COUNT") {
      list.sort(
        (a, b) => (Number(b.favoriteCount) || 0) - (Number(a.favoriteCount) || 0),
      );
    } else {
      list.sort((a, b) => {
        const timeA = a.dateUpdated ? new Date(a.dateUpdated).getTime() : 0;
        const timeB = b.dateUpdated ? new Date(b.dateUpdated).getTime() : 0;
        return (isNaN(timeB) ? 0 : timeB) - (isNaN(timeA) ? 0 : timeA);
      });
    }

    const pageSize = 30;
    const total = list.length;
    const maxPage = total > 0 ? Math.ceil(total / pageSize) : 1;
    const currentPage = typeof page === "number" && page > 0 ? page : 1;
    const start = (currentPage - 1) * pageSize;
    const pageItems = list.slice(start, start + pageSize);

    return {
      comics: pageItems.map((c) => this.parseComicCard(c)).filter(Boolean),
      maxPage: maxPage,
    };
  }

  /// 账号
  /// 设置为null禁用账号功能
  account = {
    /// 登录
    /// 返回任意值表示登录成功
    login: async (account, pwd) => {
      if (
        !account ||
        typeof account !== "string" ||
        !account.trim() ||
        !pwd ||
        typeof pwd !== "string"
      ) {
        throw "Invalid account or password";
      }

      let res = await Network.post(this.baseUrl + "/api/login", this.headers, {
        email: account,
        password: pwd,
      });

      if (res.status !== 200) {
        throw `Invalid Status Code ${res.status}`;
      }

      let json;
      try {
        json = JSON.parse(res.body);
      } catch (e) {
        throw "Failed to parse login response";
      }

      let token =
        json && typeof json.token === "string" ? json.token.trim() : null;
      if (!token) {
        throw "Failed to login: invalid token";
      }

      this.saveAuthData(token, [account, pwd]);
      return "ok";
    },

    // 退出登录时将会调用此函数
    logout: () => {
      this.clearAuthData();
    },

    registerWebsite: "https://h.komiic.com/register",
  };

  /// 探索页面
  /// 一个漫画源可以有多个探索页面
  explore = [
    {
      /// 标题
      /// 标题同时用作标识符, 不能重复
      title: "KomiicH",

      /// singlePageWithMultiPart 或者 multiPageComicList
      type: "multiPageComicList",

      load: async (page) => {
        return await this.queryComics({
          operationName: "recentUpdate",
          variables: {
            pagination: {
              limit: 20,
              offset: (page - 1) * 20,
              orderBy: "DATE_UPDATED",
              status: "",
              asc: true,
            },
          },
          query:
            "query recentUpdate($pagination: Pagination!) {\n  recentUpdate(pagination: $pagination) {\n    id\n    title\n    status\n    year\n    imageUrl\n    authors {\n      id\n      name\n      __typename\n    }\n    categories {\n      id\n      name\n      __typename\n    }\n    dateUpdated\n    monthViews\n    views\n    favoriteCount\n    lastBookUpdate\n    lastChapterUpdate\n    __typename\n  }\n}",
        });
      },
    },
  ];

  category = {
    title: "KomiicH",
    enableRankingPage: true,
    parts: [
      {
        name: "主题",

        type: "fixed",

        categories: [
          "全部",
          "愛情",
          "神鬼",
          "校園",
          "搞笑",
          "生活",
          "懸疑",
          "冒險",
          "職場",
          "魔幻",
          "後宮",
          "魔法",
          "格鬥",
          "宅男",
          "勵志",
          "耽美",
          "科幻",
          "百合",
          "治癒",
          "萌系",
          "熱血",
          "競技",
          "推理",
          "雜誌",
          "偵探",
          "偽娘",
          "美食",
          "恐怖",
          "四格",
          "社會",
          "歷史",
          "戰爭",
          "舞蹈",
          "武俠",
          "機戰",
          "音樂",
          "體育",
          "黑道",
        ],

        itemType: "category",

        // 若提供, 数量需要和`categories`一致, `categoryComics.load`方法将会收到此参数
        categoryParams: [
          "0",
          "1",
          "3",
          "4",
          "5",
          "6",
          "7",
          "8",
          "10",
          "11",
          "2",
          "12",
          "13",
          "14",
          "15",
          "16",
          "17",
          "18",
          "19",
          "20",
          "21",
          "22",
          "23",
          "24",
          "25",
          "26",
          "27",
          "9",
          "28",
          "31",
          "32",
          "33",
          "34",
          "35",
          "36",
          "37",
          "40",
          "42",
        ],
      },
    ],
  };

  /// 分类漫画页面, 即点击分类标签后进入的页面
  categoryComics = {
    load: async (category, param, options, page) => {
      let target = null;
      let isStructured = false;

      if (typeof param === "string") {
        const trimmed = param.trim();
        if (trimmed.startsWith("{")) {
          isStructured = true;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              target = parsed;
            }
          } catch (e) {
            // invalid JSON
          }
        }
      } else if (param && typeof param === "object" && !Array.isArray(param)) {
        isStructured = true;
        target = param;
      }

      if (isStructured) {
        if (!target) {
          return { comics: [], maxPage: 1 };
        }
        const type = typeof target.type === "string" ? target.type.trim() : "";
        const id =
          target.id !== null && target.id !== undefined
            ? String(target.id).trim()
            : "";
        if (!id || (type !== "author" && type !== "category")) {
          return { comics: [], maxPage: 1 };
        }
        if (type === "author") {
          return await this.queryAuthorComics(id, options, page);
        }
        param = id;
      }

      let orderBy = options && options[0] ? options[0] : "DATE_UPDATED";
      let status = options && options[1] ? options[1] : "";
      let variables = {
        pagination: {
          limit: 30,
          offset: (page - 1) * 30,
          orderBy: orderBy,
          asc: false,
          status: status,
        },
      };

      if (param !== "0") {
        variables.categoryId = [param];
      } else {
        variables.categoryId = [];
      }

      return await this.queryComics({
        operationName: "comicByCategories",
        variables: variables,
        query: `query comicByCategories($categoryId: [ID!]!, $pagination: Pagination!) {
                  comicByCategories(categoryId: $categoryId, pagination: $pagination) {
                      id
                      title
                      status
                      year
                      imageUrl
                      authors { id name __typename }
                      categories { id name __typename }
                      dateUpdated
                      monthViews
                      views
                      favoriteCount
                      lastBookUpdate
                      lastChapterUpdate
                      __typename
                  }
              }`,
      });
    },
    // 提供选项
    optionList: [
      {
        options: ["DATE_UPDATED-更新", "VIEWS-觀看數", "FAVORITE_COUNT-喜愛數"],
        notShowWhen: null,
        showWhen: null,
      },
      {
        options: ["-全部", "ONGOING-連載中", "END-完結"],
        notShowWhen: null,
        showWhen: null,
      },
    ],
    ranking: {
      options: ["MONTH_VIEWS-月", "VIEWS-綜合"],
      load: async (option, page) => {
        return this.queryComics({
          operationName: "hotComics",
          variables: {
            pagination: {
              limit: 20,
              offset: (page - 1) * 20,
              orderBy: option,
              status: "",
              asc: true,
            },
          },
          query:
            "query hotComics($pagination: Pagination!) {\n  hotComics(pagination: $pagination) {\n    id\n    title\n    status\n    year\n    imageUrl\n    authors {\n      id\n      name\n      __typename\n    }\n    categories {\n      id\n      name\n      __typename\n    }\n    dateUpdated\n    monthViews\n    views\n    favoriteCount\n    lastBookUpdate\n    lastChapterUpdate\n    __typename\n  }\n}",
        });
      },
    },
  };

  /// 搜索
  search = {
    load: async (keyword, options, page) => {
      let json = await this.queryJson({
        operationName: "searchComicAndAuthorQuery",
        variables: { keyword: keyword },
        query:
          "query searchComicAndAuthorQuery($keyword: String!) {\n  searchComicsAndAuthors(keyword: $keyword) {\n    comics {\n      id\n      title\n      status\n      year\n      imageUrl\n      authors {\n        id\n        name\n        __typename\n      }\n      categories {\n        id\n        name\n        __typename\n      }\n      dateUpdated\n      monthViews\n      views\n      favoriteCount\n      lastBookUpdate\n      lastChapterUpdate\n      __typename\n    }\n    authors {\n      id\n      name\n      chName\n      enName\n      wikiLink\n      comicCount\n      views\n      __typename\n    }\n    __typename\n  }\n}",
      });

      let comics =
        json &&
        json.data &&
        json.data.searchComicsAndAuthors &&
        Array.isArray(json.data.searchComicsAndAuthors.comics)
          ? json.data.searchComicsAndAuthors.comics
              .map((comic) => this.parseComicCard(comic))
              .filter(Boolean)
          : [];

      return {
        comics: comics,
        // 没找到最大页数的接口
        maxPage: 1,
      };
    },

    optionList: [],
  };

  /// 收藏
  favorites = {
    /// 是否为多收藏夹
    multiFolder: true,
    /// 添加或者删除收藏
    addOrDelFavorite: async (comicId, folderId, isAdding) => {
      let query = {};
      if (isAdding) {
        query = {
          operationName: "addComicToFolder",
          variables: { comicId: comicId, folderId: folderId },
          query:
            "mutation addComicToFolder($comicId: ID!, $folderId: ID!) {\n  addComicToFolder(comicId: $comicId, folderId: $folderId)\n}",
        };
      } else {
        query = {
          operationName: "removeComicToFolder",
          variables: { comicId: comicId, folderId: folderId },
          query:
            "mutation removeComicToFolder($comicId: ID!, $folderId: ID!) {\n  removeComicToFolder(comicId: $comicId, folderId: $folderId)\n}",
        };
      }
      await this.queryJson(query);
      return "ok";
    },
    // 加载收藏夹, 仅当multiFolder为true时有效
    // 当comicId不为null时, 需要同时返回包含该漫画的收藏夹
    loadFolders: async (comicId) => {
      let json = await this.queryJson({
        operationName: "myFolder",
        variables: {},
        query:
          "query myFolder {\n  folders {\n    id\n    key\n    name\n    views\n    comicCount\n    dateCreated\n    dateUpdated\n    __typename\n  }\n}",
      });
      let folders = {};
      json.data.folders.forEach((f) => {
        folders[f.id] = f.name;
      });
      let favorited = null;
      if (comicId) {
        let json2 = await this.queryJson({
          operationName: "comicInAccountFolders",
          variables: { comicId: comicId },
          query:
            "query comicInAccountFolders($comicId: ID!) {\n  comicInAccountFolders(comicId: $comicId)\n}",
        });
        favorited = json2.data.comicInAccountFolders;
      }
      return {
        folders: folders,
        favorited: favorited,
      };
    },
    /// 创建收藏夹
    addFolder: async (name) => {
      let json = await this.queryJson({
        operationName: "createFolder",
        variables: { name: name },
        query:
          "mutation createFolder($name: String!) {\n  createFolder(name: $name) {\n    id\n    key\n    name\n    account {\n      id\n      nickname\n      __typename\n    }\n    comicCount\n    views\n    dateCreated\n    dateUpdated\n    __typename\n  }\n}",
      });
      return "ok";
    },
    deleteFolder: async (id) => {
      let json = await this.queryJson({
        operationName: "removeFolder",
        variables: { folderId: id },
        query:
          "mutation removeFolder($folderId: ID!) {\n  removeFolder(folderId: $folderId)\n}",
      });
      return "ok";
    },
    /// 加载漫画
    loadComics: async (page, folder) => {
      let json = await this.queryJson({
        operationName: "folderComicIds",
        variables: {
          folderId: folder,
          pagination: {
            limit: 30,
            offset: (page - 1) * 30,
            orderBy: "DATE_UPDATED",
            status: "",
            asc: true,
          },
        },
        query:
          "query folderComicIds($folderId: ID!, $pagination: Pagination!) {\n  folderComicIds(folderId: $folderId, pagination: $pagination) {\n    folderId\n    key\n    comicIds\n    __typename\n  }\n}",
      });
      let ids = json.data.folderComicIds.comicIds;
      if (ids.length == 0) {
        return {
          comics: [],
          maxPage: 1,
        };
      }
      return this.queryComics({
        operationName: "comicByIds",
        variables: { comicIds: ids },
        query:
          "query comicByIds($comicIds: [ID]!) {\n  comicByIds(comicIds: $comicIds) {\n    id\n    title\n    status\n    year\n    imageUrl\n    authors {\n      id\n      name\n      __typename\n    }\n    categories {\n      id\n      name\n      __typename\n    }\n    dateUpdated\n    monthViews\n    views\n    favoriteCount\n    lastBookUpdate\n    lastChapterUpdate\n    __typename\n  }\n}",
      });
    },
  };

  /// 单个漫画相关
  comic = {
    // 加载漫画信息
    loadInfo: async (id) => {
      let getRecommend = async () => {
        let json = await this.queryJson({
          operationName: "recommendComicById",
          variables: { comicId: id },
          query:
            "query recommendComicById($comicId: ID!) {\n  recommendComicById(comicId: $comicId)\n}",
        });
        let recommend = (json && json.data && json.data.recommendComicById) || [];
        if (!Array.isArray(recommend) || recommend.length === 0) {
          return { comics: [], maxPage: 1 };
        }
        return this.queryComics({
          operationName: "comicByIds",
          variables: { comicIds: recommend },
          query:
            "query comicByIds($comicIds: [ID]!) {\n  comicByIds(comicIds: $comicIds) {\n    id\n    title\n    status\n    year\n    imageUrl\n    authors {\n      id\n      name\n      __typename\n    }\n    categories {\n      id\n      name\n      __typename\n    }\n    dateUpdated\n    monthViews\n    views\n    favoriteCount\n    lastBookUpdate\n    lastChapterUpdate\n    __typename\n  }\n}",
        });
      };

      let getChapter = async () => {
        let json = await this.queryJson({
          operationName: "chapterByComicId",
          variables: { comicId: id },
          query:
            "query chapterByComicId($comicId: ID!) {\n  chaptersByComicId(comicId: $comicId) {\n    id\n    serial\n    type\n    dateCreated\n    dateUpdated\n    size\n    __typename\n  }\n}",
        });
        let all = (json && json.data && json.data.chaptersByComicId) || [];
        let books = [],
          chapters = [];
        all.forEach((c) => {
          if (c.type === "book") {
            books.push(c);
          } else {
            chapters.push(c);
          }
        });
        let res = new Map();
        books.forEach((c) => {
          let name = "卷" + c.serial;
          res.set(c.id, name);
        });
        chapters.forEach((c) => {
          let name = c.serial;
          res.set(c.id, name);
        });
        return res;
      };

      let getInfo = async () => {
        let json = await this.queryJson({
          operationName: "comicById",
          variables: { comicId: id },
          query:
            "query comicById($comicId: ID!) {\n  comicById(comicId: $comicId) {\n    id\n    title\n    description\n    status\n    year\n    imageUrl\n    authors {\n      id\n      name\n      __typename\n    }\n    categories {\n      id\n      name\n      __typename\n    }\n    warnings\n    dateCreated\n    dateUpdated\n    views\n    favoriteCount\n    lastBookUpdate\n    lastChapterUpdate\n    __typename\n  }\n}",
        });
        return json.data.comicById;
      };

      let [recommendRes, chaptersRes, info] = await Promise.all([
        getRecommend(),
        getChapter(),
        getInfo(),
      ]);

      info = info || {};

      this.rememberTagTargets(info);

      let authors = [];
      if (Array.isArray(info.authors)) {
        authors = info.authors
          .map((a) => (typeof a === "string" ? a : a?.name))
          .filter((name) => typeof name === "string" && name.trim().length > 0);
      }

      let categories = [];
      if (Array.isArray(info.categories)) {
        categories = info.categories
          .map((c) => (typeof c === "string" ? c : c?.name))
          .filter((name) => typeof name === "string" && name.trim().length > 0);
      }

      let warnings = [];
      if (Array.isArray(info.warnings)) {
        warnings = info.warnings
          .map((w) => (typeof w === "string" ? w : w?.name))
          .filter((name) => typeof name === "string" && name.trim().length > 0);
      }

      let tags = {
        作者: authors,
        标签: categories,
      };
      if (warnings.length > 0) {
        tags["内容警告"] = warnings;
      }

      let updateTime = "";
      if (info.dateUpdated) {
        let d = new Date(info.dateUpdated);
        if (!isNaN(d.getTime())) {
          updateTime = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
        }
      }

      return {
        // string 标题
        title: info.title,
        // string 封面url
        cover: this.normalizeCover(info.imageUrl),
        description: info.description || "",
        // map<string, string[]> 标签
        tags: tags,
        // map<string, string>?, key为章节id, value为章节名称
        chapters: chaptersRes,
        recommend: (recommendRes && recommendRes.comics) || [],
        updateTime: updateTime,
      };
    },
    // 获取章节图片
    loadEp: async (comicId, epId) => {
      let json = await this.queryJson({
        operationName: "imagesByChapterId",
        variables: { chapterId: epId },
        query:
          "query imagesByChapterId($chapterId: ID!) {\n  imagesByChapterId(chapterId: $chapterId) {\n    id\n    kid\n    height\n    width\n    __typename\n  }\n}",
      });
      return {
        images: json.data.imagesByChapterId.map((i) => {
          return this.baseUrl + `/api/image/${i.kid}`;
        }),
      };
    },
    // 可选, 调整图片加载的行为
    onImageLoad: (url, comicId, epId) => {
      return {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          referer:
            this.baseUrl + `/comic/${comicId}/chapter/${epId}/images/all`,
        },
      };
    },
    // 加载评论
    loadComments: async (comicId, subId, page, replyTo) => {
      let operationName = replyTo ? "messageChan" : "getMessagesByComicId";
      let promise = replyTo
        ? this.queryJson({
            operationName: "messageChan",
            variables: { messageId: replyTo },
            query:
              "query messageChan($messageId: ID!) {\n  messageChan(messageId: $messageId) {\n    id\n    comicId\n    account {\n      id\n      nickname\n      profileText\n      profileTextColor\n      profileBackgroundColor\n      profileImageUrl\n      __typename\n    }\n    message\n    replyTo {\n      id\n      __typename\n    }\n    upCount\n    downCount\n    dateUpdated\n    dateCreated\n    __typename\n  }\n}",
          })
        : this.queryJson({
            operationName: "getMessagesByComicId",
            variables: {
              comicId: comicId,
              pagination: {
                limit: 100,
                offset: (page - 1) * 100,
                orderBy: "DATE_UPDATED",
                asc: true,
              },
            },
            query:
              "query getMessagesByComicId($comicId: ID!, $pagination: Pagination!) {\n  getMessagesByComicId(comicId: $comicId, pagination: $pagination) {\n    id\n    comicId\n    account {\n      id\n      nickname\n      profileText\n      profileTextColor\n      profileBackgroundColor\n      profileImageUrl\n      __typename\n    }\n    message\n    replyTo {\n      id\n      message\n      account {\n        id\n        nickname\n        profileText\n        profileTextColor\n        profileBackgroundColor\n        profileImageUrl\n        __typename\n      }\n      __typename\n    }\n    upCount\n    downCount\n    dateUpdated\n    dateCreated\n    __typename\n  }\n}",
          });
      let json = await promise;
      return {
        comments: json.data[operationName].map((e) => {
          return {
            // string
            userName: e.account.nickname,
            // string
            avatar: e.account.profileImageUrl,
            // string
            content: e.message,
            // string?
            time: e.dateUpdated,
            // number?
            // TODO: 没有数量信息, 但是设为null会禁用回复功能
            replyCount: 0,
            // string
            id: e.id,
          };
        }),
        maxPage: null,
      };
    },
    // 发送评论, 返回任意值表示成功
    sendComment: async (comicId, subId, content, replyTo) => {
      if (!replyTo) {
        replyTo = "0";
      }
      let json = await this.queryJson({
        operationName: "addMessageToComic",
        variables: { comicId: comicId, message: content, replyToId: replyTo },
        query:
          "mutation addMessageToComic($comicId: ID!, $replyToId: ID!, $message: String!) {\n  addMessageToComic(message: $message, comicId: $comicId, replyToId: $replyToId) {\n    id\n    message\n    comicId\n    account {\n      id\n      nickname\n      __typename\n    }\n    replyTo {\n      id\n      message\n      account {\n        id\n        nickname\n        profileText\n        profileTextColor\n        profileBackgroundColor\n        profileImageUrl\n        __typename\n      }\n      __typename\n    }\n    dateCreated\n    dateUpdated\n    __typename\n  }\n}",
      });
      return "ok";
    },
    onClickTag: (namespace, tag) => {
      const target = this.getTagTarget(namespace, tag);
      if (!target) {
        return null;
      }
      const trimmedTag = typeof tag === "string" ? tag.trim() : "";
      const title =
        target.type === "author" ? `作者：${trimmedTag}` : trimmedTag;
      return {
        page: "category",
        attributes: {
          category: title,
          param: JSON.stringify({ type: target.type, id: target.id }),
        },
      };
    },
  };

  /// 链接处理
  /// 用于从浏览器跳转回 App 时识别本源
  link = {
    // 接受的域名列表，包含主站与各镜像
    domains: ["h.komiic.com", "h.komiic.cc"],
    // 将 url 解析为漫画 id
    linkToId: (url) => {
      // 形如 https://h.komiic.com/comic/12345
      let match = url.match(/\/comic\/(\d+)/);
      if (match) {
        return match[1];
      }
      return null;
    },
  };

  /// 设置
  /// 提供多域名切换，遇到某域名失效时可自助切换
  settings = {
    domain: {
      title: "访问域名",
      type: "select",
      options: [
        { value: "https://h.komiic.com", text: "主站 (h.komiic.com)" },
        {
          value: "https://h.komiic.cc",
          text: "中国大陆线路 (h.komiic.cc，速度更稳定)",
        },
      ],
      default: "https://h.komiic.com",
    },
  };

  // 翻译
  translation = {
    zh_CN: {
      访问域名: "访问域名",
    },
    zh_TW: {
      访问域名: "訪問域名",
    },
    en: {
      访问域名: "Domain",
    },
  };
}
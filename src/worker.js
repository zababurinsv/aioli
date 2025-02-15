import * as Comlink from "comlink";
import { simd, threads } from "wasm-feature-detect";

const LOADING_EAGER = "eager";
const LOADING_LAZY = "lazy";

const aioli = {
	// Configuration
	tools: [],   // Genomics tools that are available to use in this WebWorker
	config: {},  // See main.js for defaults
	files: [],   // File/Blob objects that represent local user files we mount to a virtual filesystem
	fs: {},      // Main WebAssembly module's filesystem (equivalent to aioli.tools[0].module.FS)

	// =========================================================================
	// Initialize the WebAssembly module(s)
	// Supports array of tool info, where each tool is represented by:
	// 		{
	// 			tool: "samtools",                             // Required
	// 			version: "1.10",                              // Required
	// 			program: "samtools",                          // Optional, default="tool" name. Only use this for tools with multiple subtools
	// 			urlPrefix: "https://cdn.biowasm.com/v2/...",  // Optional, default=biowasm CDN. Only use for local biowasm development
	// 			loading: "eager",                             // Optional, default="eager". Set to "lazy" to only load modules when they are used in exec()
	// 			reinit: false,                                // Optional, default="false". Set to "true" to reinitialize a module after each invocation
	// 		},
	// =========================================================================
	async init()
	{
		// The base biowasm module is always there ==> expect at least 2 modules
		if(aioli.tools.length < 2)
			throw "Expecting at least 1 tool.";

		// ---------------------------------------------------------------------
		// Set up base module (do that first so that its filesystem is ready for
		// the other modules to mount in parallel)
		// ---------------------------------------------------------------------

		const baseModule = aioli.tools[0];
		await this._setup(baseModule, true);

		// The base module has the main filesystem, which other tools will mount
		baseModule.module.FS.mkdir(aioli.config.dirData, 0o777);
		baseModule.module.FS.mkdir(aioli.config.dirMounted, 0o777);
		baseModule.module.FS.chdir(aioli.config.dirData);
		aioli.fs = baseModule.module.FS;

		// ---------------------------------------------------------------------
		// Set up all other modules
		// ---------------------------------------------------------------------

		// First module that isn't the base module can't be lazy-loaded. This is
		// because we use the first module as the one where the main filesystem
		// is mounted.
		if(aioli.tools[1].loading == LOADING_LAZY)
			aioli.tools[1].loading = LOADING_EAGER;

		// Initialize modules
		await this._initModules();
		aioli._log("Ready");
		return true;
	},

	// Initialize all modules that should be eager-loaded (i.e. not lazy-loaded)
	async _initModules() {
		// Initialize main tool first since rely on it for filesystem paths
		await this._setup(aioli.tools[1]);
		// Initialize WebAssembly modules (downloads .wasm/.js/.json in parallel)
		await Promise.all(aioli.tools.slice(2).map(tool => this._setup(tool)));

		// Setup filesystems so that tools can access each other's sample data
		await this._setupFS();
	},

	// =========================================================================
	// Mount files to the virtual file system
	// Supports <FileList>, <File>, <Blob>, and string URLs:
	//		mount(<FileList>)
	//		mount([ <File>, { name: "blob.txt", data: <Blob> }, "https://somefile.com" ])
	// =========================================================================
	mount(files)
	{
		const dirData = aioli.config.dirData;
		const dirShared = aioli.config.dirShared;
		const dirMounted = aioli.config.dirMounted;

		// Input validation. Note that FileList is not an array so we can't use Array.isArray() but it does have a
		// length attribute. So do strings, which is why we explicitly check for those.
		let toMount = [], mountedPaths = [];
		if(!files?.length || typeof files === "string")
			files = [ files ];
		aioli._log(`Mounting ${files.length} files`);

		// Sort files by type: File vs. Blob vs. URL
		for(let file of files)
		{
			// Handle File/Blob objects
			// Blob formats: { name: "filename.txt", data: new Blob(['blob data']) }
			if(file instanceof File || (file?.data instanceof Blob && file.name)) {
				toMount.push(file);
				mountedPaths.push(file.name);

			// Handle URLs: mount "https://website.com/some/path.js" to "/urls/website.com-some-path.js")
			} else if(typeof file == "string" && file.startsWith("http")) {
				// Mount a URL "lazily" to the file system, i.e. don't download any of it, but will automatically do
				// HTTP Range requests when a tool requests a subset of bytes from that file.
				const fileName = file.split("//").pop().replace(/\//g, "-");
				aioli.fs.createLazyFile(dirData, fileName, file, true, true);
				mountedPaths.push(fileName);

			// Otherwise, incorrect data provided
			} else {
				throw "Cannot mount file(s) specified. Must be a File, Blob, or a URL string.";
			}
		}

		// Unmount and remount Files and Blobs since WORKERFS is read-only (i.e. can only mount a folder once)
		try {
			aioli.fs.unmount(dirMounted);
		} catch(e) {}

		// Mount File & Blob objects
		aioli.files = aioli.files.concat(toMount);
		aioli.fs.mount(aioli.tools[0].module.WORKERFS, {
			files: aioli.files.filter(f => f instanceof File),
			blobs: aioli.files.filter(f => f?.data instanceof Blob)
		}, dirMounted);

		// Create symlinks for convenience. The folder "dirMounted" is a WORKERFS, which is read-only. By adding
		// symlinks to a separate writeable folder "dirData", we can support commands like "samtools index abc.bam",
		// which create a "abc.bam.bai" file in the same path where the .bam file is created.
		toMount.map(file => {
			const oldpath = `${dirShared}${dirMounted}/${file.name}`;
			const newpath = `${dirShared}${dirData}/${file.name}`;
			try {
				aioli.tools[1].module.FS.unlink(newpath);
			} catch(e) {}
			aioli._log(`Creating symlink: ${newpath} --> ${oldpath}`)

			// Create symlink within first module's filesystem (note: tools[0] is always the "base" biowasm module)
			aioli.tools[1].module.FS.symlink(oldpath, newpath);
		})

		return mountedPaths.map(path => `${dirShared}${dirData}/${path}`);
	},

	// =========================================================================
	// Execute a command
	// =========================================================================
	async exec(command, args=null)
	{
		// Input validation
		aioli._log(`Executing %c${command}%c args=${args}`, "color:darkblue; font-weight:bold", "");
		if(!command)
			throw "Expecting a command";
		// Extract tool name and arguments
		let toolName = command;
		if(args == null) {
			args = command.split(" ");
			toolName = args.shift();
		}

		// Does it match a program we've already initialized?
		const tools = aioli.tools.filter(t => {
			let tmpToolName = toolName;
			// Take special WebAssembly features into account
			if(t?.features?.simd === false)
				tmpToolName = `${tmpToolName}-nosimd`;
			if(t?.features?.threads === false)
				tmpToolName = `${tmpToolName}-nothreads`;
			return t.program == tmpToolName;
		});
		if(tools.length == 0)
			throw `Program ${toolName} not found.`;
		// Prepare tool
		const tool = tools[0];		
		tool.stdout = "";
		tool.stderr = "";

		// If this is a lazy-loaded module, load it now by setting it to eager loading.
		// Note that calling _initModules will only load modules that haven't yet been loaded.
		if(tool.loading == LOADING_LAZY) {
			tool.loading = LOADING_EAGER;
			await this._initModules();
		}

		// Run command. Stdout/Stderr will be saved to "tool.stdout"/"tool.stderr" (see "print" and "printErr" above)
		try {
			tool.module.callMain(args);
		} catch (error) {
			console.error(error)
		}

		// Flush stdout/stderr to make sure we got everything. Otherwise, if use a command like 
		// `bcftools query -f "%ALT" variants.bcf`, it won't output anything until the next
		// invocation of that command!
		try {
			tool.module.FS.close( tool.module.FS.streams[1] );
			tool.module.FS.close( tool.module.FS.streams[2] );
		} catch (error) {}
		// Re-open stdout/stderr (fix error "error closing standard output: -1")
		tool.module.FS.streams[1] = tool.module.FS.open("/dev/stdout", "w");
		tool.module.FS.streams[2] = tool.module.FS.open("/dev/stderr", "w");

		// Return output, either stdout/stderr interleaved, or each one separately
		let result = { stdout: tool.stdout, stderr: tool.stderr };
		if(aioli.config.printInterleaved)
			result = tool.stdout;

		// Reinitialize module after done? This is useful for tools that don't properly reset their global state the
		// second time the `main()` function is called.
		if(tool.reinit === true) {
			// Save working directory so we can return to it after reinitialization
			const pwd = tool.module.FS.cwd();
			// Reset config
			Object.assign(tool, tool.config);
			tool.ready = false;
			// Reinitialize module + setup FS
			await this._setup(tool);
			await this._setupFS();
			await this.cd(pwd);
		}

		return result;
	},

	// =========================================================================
	// Utility functions for common file operations
	// =========================================================================
	cat(path) {
		return aioli._fileop("cat", path);
	},

	ls(path) {
		return aioli._fileop("ls", path);
	},

	download(path) {
		return aioli._fileop("download", path);
	},

	cd(path) {
		for(let i = 1; i < aioli.tools.length; i++) {
			const module = aioli.tools[i].module;
			// Ignore modules that haven't been initialized yet (i.e. lazy-loaded modules)
			if(!module)
				continue;
			aioli.tools[i].module.FS.chdir(path);
		}
	},

	mkdir(path) {
		aioli.tools[1].module.FS.mkdir(path);
		return true;
	},

	// =========================================================================
	// Initialize a tool
	// =========================================================================

	async _setup(tool, isBaseModule=false)
	{
		if(tool.ready)
			return;

		// Save original config in case need them to reinitialize (use Object.assign to avoid ref changes)
		tool.config = Object.assign({}, tool);

		// -----------------------------------------------------------------
		// Set default settings
		// -----------------------------------------------------------------

		// By default, use the CDN path, but also accept custom paths for each tool
		if(!tool.urlPrefix)
			tool.urlPrefix = `${aioli.config.urlCDN}/${tool.tool}/${tool.version}`;

		// In most cases, the program is the same as the tool name, but there are exceptions. For example, for the
		// tool "seq-align", program can be "needleman_wunsch", "smith_waterman", or "lcs".
		if(!tool.program)
			tool.program = tool.tool;

		// SIMD and Threads are WebAssembly features that aren't enabled on all browsers. In those cases, we
		// load the right version of the .wasm binaries based on what is supported by the user's browser.
		if(!isBaseModule && !tool.features) {
			tool.features = {};
			const toolConfig = await fetch(`${tool.urlPrefix}/config.json`).then(d => d.json());
			if(toolConfig["wasm-features"]?.includes("simd") && !await simd()) {
				console.warn(`[biowasm] SIMD is not supported in this browser. Loading slower non-SIMD version of ${tool.program}.`);
				tool.program += "-nosimd";
				tool.features.simd = false;
			}
			if(toolConfig["wasm-features"]?.includes("threads") && !await threads()) {
				console.warn(`[biowasm] Threads are not supported in this browser. Loading slower non-threaded version of ${tool.program}.`);
				tool.program += "-nothreads";
				tool.features.threads = false;
			}
		}

		// If want lazy loading, don't go any further
		if(tool.loading == LOADING_LAZY)
			return;

		// -----------------------------------------------------------------
		// Import the WebAssembly module
		// -----------------------------------------------------------------

		// All biowasm modules export the variable "Module" so assign it
		self.importScripts(`${tool.urlPrefix}/${tool.program}.js`);

		// Initialize the Emscripten module and pass along settings to overwrite
		tool.module = await Module({
			// By default, tool name is hardcoded as "./this.program"
			thisProgram: tool.program,
			// Used by Emscripten to find path to .wasm / .data files
			locateFile: (path, prefix) => `${tool.urlPrefix}/${path}`,
			// Setup print functions to store stdout/stderr output
			print: text => tool.stdout += `${text}\n`,
			printErr: aioli.config.printInterleaved ? text => tool.stdout += `${text}\n` : text => tool.stderr += `${text}\n`
		});

		// -----------------------------------------------------------------
		// Setup shared virtual file system
		// -----------------------------------------------------------------

		if(!isBaseModule) {
			// PROXYFS allows us to point "/shared" to the base module's filesystem "/"
			const FS = tool.module.FS;
			FS.mkdir(aioli.config.dirShared);
			FS.mount(tool.module.PROXYFS, {
				root: "/",
				fs: aioli.fs
			}, aioli.config.dirShared);

			// Set the working directory to be that mount folder for convenience if
			// this is the first non-base module.
			if(aioli.tools[1] == tool)
				FS.chdir(`${aioli.config.dirShared}${aioli.config.dirData}`);
			// If it's not, we're initializing a new module, so we want it to be synced with
			// the first non-base module (e.g. if lazy load 1 module, then cd, then load new
			// module, must ensure both modules have the same working directory!)
			else
				FS.chdir(aioli.tools[1].module.FS.cwd());
		}

		// -----------------------------------------------------------------
		// Initialize variables
		// -----------------------------------------------------------------

		tool.stdout = "";
		tool.stderr = "";
		tool.ready = true;
	},

	// Setup filesystems so that tools can access each other's sample data
	async _setupFS()
	{
		// Some tools have preloaded files mounted to their filesystems to hold sample data (e.g. /samtools/examples/).
		// By default, those are only accessible from the filesystem of the respective tool. Here, we want to allow
		// other modules to also have access to those sample data files.
		for(let i in aioli.tools)
		{
			// Skip base module, and lazy-loaded modules
			if(i == 0 || aioli.tools[i].loading == LOADING_LAZY)
				continue;

			for(let j in aioli.tools)
			{
				// Skip base module, self, and lazy-loaded modules
				if(j == 0 || i == j || aioli.tools[j].loading == LOADING_LAZY)
					continue;

				const fsSrc = aioli.tools[i].module.FS;
				const fsDst = aioli.tools[j].module.FS;
				
				// Make sure source tool actually has such a folder (must be the same as the "module", not "program").
				// Skip if the destination filesystem already has that folder (could theoretically happen if initialize)
				// two copies of the same module.
				const path = `/${aioli.tools[i].tool}`;
				if(!fsSrc.analyzePath(path).exists || fsDst.analyzePath(path).exists)
					continue;

				aioli._log(`Mounting ${path} onto ${aioli.tools[j].tool} filesystem`);
				fsDst.mkdir(path);
				fsDst.mount(aioli.tools[0].module.PROXYFS, {
					root: path,
					fs: fsSrc
				}, path);
			}
		}
	},

	// =========================================================================
	// Utilities
	// =========================================================================

	// Common file operations
	_fileop(operation, path) {
		aioli._log(`Running ${operation} ${path}`);

		// Check whether the file exists
		const FS = aioli.tools[1].module.FS;
		const info = FS.analyzePath(path);
		if(!info.exists) {
			aioli._log(`File ${path} not found.`);
			return false;
		}

		// Execute operation of interest
		switch (operation) {
			case "cat":
				return FS.readFile(path, { encoding: "utf8" });
		
			case "ls":
				if(FS.isFile(info.object.mode))
					return FS.stat(path);
				return FS.readdir(path);

			case "download":
				const blob = new Blob([ this.cat(path) ]);
				return URL.createObjectURL(blob);
		}

		return false;
	},

	// Log if debug enabled
	_log(message) {
		if(!aioli.config.debug)
			return;

		// Support custom %c arguments
		let args = [...arguments];
		args.shift();
		console.log(`%c[WebWorker]%c ${message}`, "font-weight:bold", "", ...args);
	}
};

Comlink.expose(aioli);

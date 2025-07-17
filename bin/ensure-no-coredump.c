#ifdef _WIN32

void ensure_no_coredump(void) {}

#else // !defined(_WIN32)

#include <sys/resource.h>

void ensure_no_coredump(void) {
	struct rlimit rl;
	getrlimit(RLIMIT_CORE, &rl);
	if (rl.rlim_cur > 0) {
		rl.rlim_cur = 0;
		setrlimit(RLIMIT_CORE, &rl);
	}
}

#endif // _WIN32

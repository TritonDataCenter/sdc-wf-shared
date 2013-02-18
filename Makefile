#
# Copyright (c) 2013, Joyent, Inc. All rights reserved.
#
# wf-shared Makefile


#
# Files
#
JS_FILES	:= $(shell find lib -name '*.js')
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE   = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS    = -f tools/jsstyle.conf


include ./tools/mk/Makefile.deps
include ./tools/mk/Makefile.targ
